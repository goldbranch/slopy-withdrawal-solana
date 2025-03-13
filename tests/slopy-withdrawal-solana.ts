import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SlopyWithdrawalSolana } from "../target/types/slopy_withdrawal_solana";
import { assert } from "chai";
import {
  createAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { serialize } from "borsh";

class WithdrawMessage {
  nonce: number;
  amount: number;
  recipient: Uint8Array;
  slot: number;

  constructor(fields: {
    nonce: number;
    amount: number;
    recipient: Uint8Array;
    slot: number;
  }) {
    this.nonce = fields.nonce;
    this.amount = fields.amount;
    this.recipient = fields.recipient;
    this.slot = fields.slot;
  }
}

const schema = new Map([
  [
    WithdrawMessage,
    {
      kind: "struct",
      fields: [
        ["nonce", "u32"],
        ["amount", "u64"],
        ["recipient", [32]],
        ["slot", "u64"],
      ],
    },
  ],
]);

describe("slopy_withdrawal_solana", () => {
  // Создаем локальный провайдер
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .SlopyWithdrawalSolana as Program<SlopyWithdrawalSolana>;

  let stateAccount: anchor.web3.Keypair;
  let vaultAccount: anchor.web3.Keypair;
  let slopyMint: anchor.web3.PublicKey;
  let vaultSigner: anchor.web3.PublicKey;
  let serverPrivateKey: Uint8Array;
  let serverPublicKey: Uint8Array;
  let nonce = 0;

  before(async () => {
    // Генерация серверного ключа
    serverPrivateKey = secp256k1.utils.randomPrivateKey();
    const serverPublicKeyFull = secp256k1.getPublicKey(serverPrivateKey, false); // 65 байт
    serverPublicKey = serverPublicKeyFull.slice(1); // 64 байта

    stateAccount = anchor.web3.Keypair.generate();
    vaultAccount = anchor.web3.Keypair.generate();

    const [vaultSignerPubkey] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_signer")],
      program.programId
    );
    vaultSigner = vaultSignerPubkey;

    // Создаем mint для USDT
    slopyMint = await createMint(
      provider.connection, // Соединение с Solana
      (provider.wallet as NodeWallet).payer, // Ключ для оплаты транзакции
      provider.wallet.publicKey, // Владелец (mint authority)
      null, // Freeze authority (не используем)
      6 // Количество десятичных знаков (USDT = 6)
    );

    await program.methods
      .initialize(Array.from(serverPublicKey))
      .accounts({
        state: stateAccount.publicKey,
        vault: vaultAccount.publicKey,
        slopyMint: slopyMint,
        authority: provider.wallet.publicKey,
      })
      .signers([stateAccount, vaultAccount])
      .rpc();

    await mintTo(
      provider.connection,
      (provider.wallet as NodeWallet).payer,
      slopyMint,
      vaultAccount.publicKey,
      provider.wallet.publicKey,
      1000000000
    );
  });

  it("Initializes the contract", async () => {
    // Проверяем, что состояние контракта было инициализировано корректно
    const state = await program.account.withdrawState.fetch(
      stateAccount.publicKey
    );
    assert.deepEqual(state.serverPubkey, Array.from(serverPublicKey));
    assert.deepEqual(state.usedNonces, []);
  });

  it("Withdraws funds successfully", async () => {
    // Создаем получателя и его токен-аккаунт
    const recipient = anchor.web3.Keypair.generate();
    const recipientTokenAccount = await createAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      slopyMint,
      recipient.publicKey, // Владелец токен-аккаунта
      undefined, // Использовать случайный ключ (автоматически сгенерируется)
      undefined, // Опции подтверждения по умолчанию
      TOKEN_PROGRAM_ID // Указываем программу токенов
    );

    // Получаем текущий слот
    const currentSlot = await provider.connection.getSlot();
    nonce++;
    const amount = 1000000; // 1 USDT (6 decimals)
    const slot = currentSlot;

    // Создаем и сериализуем сообщение
    const message = new WithdrawMessage({
      nonce: nonce,
      amount: amount,
      recipient: recipient.publicKey.toBytes(),
      slot: slot,
    });
    const messageBytes = serialize(schema, message);
    const messageHash = keccak_256(messageBytes);

    // Подписываем сообщение серверным приватным ключом
    const sig = secp256k1.sign(messageHash, serverPrivateKey);
    const signature = Array.from(sig.toCompactRawBytes());
    const recoveryId = sig.recovery;

    // Вызываем инструкцию withdraw
    await program.methods
      .withdraw(
        nonce,
        new anchor.BN(amount),
        recipient.publicKey,
        new anchor.BN(slot),
        signature,
        recoveryId
      )
      .accounts({
        state: stateAccount.publicKey,
        vault: vaultAccount.publicKey,
        recipientTokenAccount: recipientTokenAccount,
      })
      .rpc();

    // Проверяем балансы
    const vaultBalance = await getAccount(
      provider.connection,
      vaultAccount.publicKey
    );
    const recipientBalance = await getAccount(
      provider.connection,
      recipientTokenAccount
    );

    assert.equal(vaultBalance.amount, BigInt(1000000000 - amount));
    assert.equal(recipientBalance.amount, BigInt(amount));

    // Проверяем, что nonce добавлен в usedNonces
    const state = await program.account.withdrawState.fetch(
      stateAccount.publicKey
    );
    const usedNonce = state.usedNonces.find(
      (n) => n.nonce === nonce && n.slot.eqn(slot)
    );
    assert.exists(usedNonce, "Nonce should be added to usedNonces");
  });

  it("Rejects withdrawal with invalid signature", async () => {
    const recipient = anchor.web3.Keypair.generate();
    const recipientTokenAccount = await createAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      slopyMint,
      recipient.publicKey,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    const currentSlot = await provider.connection.getSlot();
    nonce++;
    const amount = 1000000;

    const message = new WithdrawMessage({
      nonce: nonce,
      amount: amount,
      recipient: recipient.publicKey.toBytes(),
      slot: currentSlot,
    });
    const messageBytes = serialize(schema, message);
    const messageHash = keccak_256(messageBytes);

    // Генерируем НЕВЕРНЫЙ приватный ключ
    const invalidPrivateKey = secp256k1.utils.randomPrivateKey();
    const invalidSig = secp256k1.sign(messageHash, invalidPrivateKey);
    const invalidSignature = Array.from(invalidSig.toCompactRawBytes());
    const invalidRecoveryId = invalidSig.recovery;

    const vaultBalanceBefore = await getAccount(
      provider.connection,
      vaultAccount.publicKey
    );

    // Пытаемся вызвать withdraw с неверной подписью
    try {
      await program.methods
        .withdraw(
          nonce,
          new anchor.BN(amount),
          recipient.publicKey,
          new anchor.BN(currentSlot),
          invalidSignature,
          invalidRecoveryId
        )
        .accounts({
          state: stateAccount.publicKey,
          vault: vaultAccount.publicKey,
          recipientTokenAccount: recipientTokenAccount,
        })
        .rpc();

      assert.fail("Transaction should have failed with InvalidSignature");
    } catch (err) {
      // Проверяем код ошибки
      assert.equal(err.error.errorCode.code, "InvalidSignature");
    }

    // Проверяем, что балансы не изменились
    const vaultBalanceAfter = await getAccount(
      provider.connection,
      vaultAccount.publicKey
    );

    assert.equal(vaultBalanceBefore.amount, vaultBalanceAfter.amount);
  });

  it("Rejects duplicate withdrawal request", async () => {
    // Уникальный nonce для теста
    const duplicateNonce = 9999;

    // Создаем получателя и его токен-аккаунт
    const recipient = anchor.web3.Keypair.generate();
    const recipientTokenAccount = await createAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      slopyMint,
      recipient.publicKey,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Получаем текущий слот
    const currentSlot = await provider.connection.getSlot();
    const amount = 1000000; // 1 USDT

    // Создаем сообщение для подписи
    const message = new WithdrawMessage({
      nonce: duplicateNonce,
      amount: amount,
      recipient: recipient.publicKey.toBytes(),
      slot: currentSlot,
    });
    const messageBytes = serialize(schema, message);
    const messageHash = keccak_256(messageBytes);

    // Подписываем сообщение серверным ключом
    const sig = secp256k1.sign(messageHash, serverPrivateKey);
    const signature = Array.from(sig.toCompactRawBytes());
    const recoveryId = sig.recovery;

    // Первый вывод - должен быть успешным
    await program.methods
      .withdraw(
        duplicateNonce,
        new anchor.BN(amount),
        recipient.publicKey,
        new anchor.BN(currentSlot),
        signature,
        recoveryId
      )
      .accounts({
        state: stateAccount.publicKey,
        vault: vaultAccount.publicKey,
        recipientTokenAccount: recipientTokenAccount,
      })
      .rpc();

    // Проверяем баланс после первого вывода
    const recipientBalanceAfterFirst = await getAccount(
      provider.connection,
      recipientTokenAccount
    );
    assert.equal(recipientBalanceAfterFirst.amount, BigInt(amount));

    // Пытаемся выполнить повторный вывод с тем же nonce
    try {
      await program.methods
        .withdraw(
          duplicateNonce,
          new anchor.BN(amount),
          recipient.publicKey,
          new anchor.BN(currentSlot),
          signature,
          recoveryId
        )
        .accounts({
          state: stateAccount.publicKey,
          vault: vaultAccount.publicKey,
          recipientTokenAccount: recipientTokenAccount,
        })
        .rpc();

      assert.fail("Transaction should have failed with DuplicateWithdrawal");
    } catch (err) {
      // Проверяем код ошибки
      assert.equal(err.error.errorCode.code, "DuplicateWithdrawal");
    }

    // Проверяем, что баланс не изменился
    const recipientBalanceAfterSecond = await getAccount(
      provider.connection,
      recipientTokenAccount
    );
    assert.equal(recipientBalanceAfterSecond.amount, BigInt(amount));

    // Проверяем наличие nonce в списке использованных
    const state = await program.account.withdrawState.fetch(
      stateAccount.publicKey
    );
    const usedNonce = state.usedNonces.find(
      (n) => n.nonce === duplicateNonce && n.slot.eqn(currentSlot)
    );
    assert.exists(usedNonce, "Nonce should be in usedNonces");
  });
});
