#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::secp256k1_recover::secp256k1_recover;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("HCqJrtrdZ1K4D3MXFYowrJ8fP6TVQXvpLxMHVAWUCRQ2");

#[program]
pub mod slopy_withdrawal_solana {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, server_pubkey: [u8; 64]) -> Result<()> {
        ctx.accounts.state.server_pubkey = server_pubkey;
        Ok(())
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
        nonce: u32,
        amount: u64,
        recipient: Pubkey,
        slot: u64,
        signature: [u8; 64],
        recovery_id: u8,
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let current_slot = Clock::get()?.slot;

        // Проверка актуальности запроса
        if slot + 150 < current_slot {
            return Err(ErrorCode::ExpiredWithdrawalRequest.into());
        }

        // Проверка подписи сервера
        let message = WithdrawMessage {
            nonce,
            amount,
            recipient,
            slot,
        };
        let message_bytes = message.try_to_vec()?;
        let message_hash = keccak::hash(&message_bytes).to_bytes();

        let recovered_pubkey = secp256k1_recover(&message_hash, recovery_id, &signature)
            .map_err(|_| ErrorCode::InvalidSignature)?;

        if recovered_pubkey.to_bytes() != state.server_pubkey {
            return Err(ErrorCode::InvalidSignature.into());
        }

        // Проверка владельца токен-аккаунта
        if ctx.accounts.recipient_token_account.owner != recipient {
            return Err(ErrorCode::InvalidRecipient.into());
        }
        if ctx.accounts.recipient_token_account.mint != ctx.accounts.vault.mint {
            return Err(ErrorCode::InvalidRecipient.into());
        }

        // Проверка на повторное использование nonce
        if state.used_nonces.iter().any(|u| u.nonce == nonce) {
            return Err(ErrorCode::DuplicateWithdrawal.into());
        }

        // Очистка старых nonce
        let min_valid_slot = current_slot.saturating_sub(150);
        state.used_nonces.retain(|u| u.slot >= min_valid_slot);

        if state.used_nonces.len() >= 100 {
            return Err(ErrorCode::NonceListFull.into());
        }

        state.used_nonces.push(UsedNonce { nonce, slot });

        let bump = ctx.bumps.vault_signer;
        let seeds: &[&[u8]] = &[b"vault_signer".as_ref(), &bump.to_le_bytes()];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.vault_signer.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + 64 + 4 + (100 * 12))]
    pub state: Account<'info, WithdrawState>,

    #[account(
        init,
        payer = authority,
        token::mint = slopy_mint,
        token::authority = vault_signer,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub slopy_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: PDA для подписи переводов
    #[account(
        seeds = [b"vault_signer"],
        bump,
    )]
    pub vault_signer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub state: Account<'info, WithdrawState>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    /// CHECK: PDA для подписи
    #[account(
        seeds = [b"vault_signer"],
        bump,
    )]
    pub vault_signer: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
}

#[account]
pub struct WithdrawState {
    pub server_pubkey: [u8; 64],
    pub used_nonces: Vec<UsedNonce>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UsedNonce {
    pub nonce: u32,
    pub slot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
struct WithdrawMessage {
    nonce: u32,
    amount: u64,
    recipient: Pubkey,
    slot: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid server signature")]
    InvalidSignature,
    #[msg("Withdrawal request expired")]
    ExpiredWithdrawalRequest,
    #[msg("Duplicate withdrawal attempt")]
    DuplicateWithdrawal,
    #[msg("Nonce list is full")]
    NonceListFull,
    #[msg("Recipient token account owner does not match the provided recipient address")]
    InvalidRecipient,
}
