use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token::{mint_to, set_authority, transfer, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer}};
use svm_merkle_tree::{HashingAlgorithm, MerkleProof};

declare_id!("GTCPuHiGookQVSAgGc7CzBiFYPytjVAq6vdCV3NnZoHa");

#[program]
pub mod merkle_tree_token_claimer {
    use anchor_spl::token::spl_token::instruction::AuthorityType;

    use super::*;

    pub fn initialize_airdrop_data(
        ctx: Context<Initialize>, 
        merkle_root: [u8; 32],
        amount: u64,
    ) -> Result<()> {

        ctx.accounts.airdrop_state.set_inner(
            AirdropState {
                merkle_root,
                authority: ctx.accounts.authority.key(),
                mint: ctx.accounts.mint.key(),
                airdrop_amount: amount,
                amount_claimed: 0,
                bump: ctx.bumps.airdrop_state,
            }
        );

        mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(), 
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                }
            ),
            amount
        )?;

        set_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(), 
                SetAuthority {
                    current_authority: ctx.accounts.authority.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                }
            ), 
            AuthorityType::MintTokens,
            None
        )?;

        Ok(())
    }

    pub fn update_tree(
        ctx: Context<Update>, 
        new_root: [u8; 32]
    ) -> Result<()> {

        ctx.accounts.airdrop_state.merkle_root = new_root;

        Ok(())
    }

    pub fn claim_airdrop(
        ctx: Context<Claim>,
        amount: u64,
        hashes: Vec<u8>,
        index: u64,
    ) -> Result<()> {    
        let airdrop_state = &mut ctx.accounts.airdrop_state;
    
        // Step 1: Verify that the Signer and Amount are right by computing the original leaf
        let mut original_leaf = Vec::new();
        original_leaf.extend_from_slice(&ctx.accounts.signer.key().to_bytes());
        original_leaf.extend_from_slice(&amount.to_le_bytes());
        original_leaf.push(0u8); // isClaimed = false
    
        // Step 2: Verify the Merkle proof against the on-chain root
        let merkle_proof = MerkleProof::new(
            HashingAlgorithm::Keccak,
            32,
            index as u32,
            hashes.clone(),
        );
    
        let computed_root = merkle_proof
            .merklize(&original_leaf)
            .map_err(|_| WhitelistError::InvalidProof)?;
    
        require!(
            computed_root.eq(&airdrop_state.merkle_root),
            WhitelistError::InvalidProof
        );
    
        // Step 3: Execute the transfer
        let mint_key = ctx.accounts.mint.key().to_bytes();
        let signer_seeds = &[
            b"merkle_tree".as_ref(),
            mint_key.as_ref(),
            &[airdrop_state.bump],
        ];
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.signer_ata.to_account_info(),
                    authority: airdrop_state.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;
    
        // Step 4: Update the `is_claimed` flag in the leaf
        let mut updated_leaf = Vec::new();
        updated_leaf.extend_from_slice(&ctx.accounts.signer.key().to_bytes());
        updated_leaf.extend_from_slice(&amount.to_le_bytes());
        updated_leaf.push(1u8); // isClaimed = true
    
        let updated_root: [u8; 32] = merkle_proof
            .merklize(&updated_leaf)
            .map_err(|_| WhitelistError::InvalidProof)?
            .try_into()
            .map_err(|_| WhitelistError::InvalidProof)?;
    
        // Step 5: Update the Merkle root in the airdrop state
        airdrop_state.merkle_root = updated_root;
    
        // Step 6: Update the airdrop state
        airdrop_state.amount_claimed = airdrop_state
            .amount_claimed
            .checked_add(amount)
            .ok_or(WhitelistError::OverFlow)?;
    
        Ok(())
    }
    
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init, 
        seeds = [b"merkle_tree".as_ref(), mint.key().to_bytes().as_ref()],
        bump,
        payer = authority, 
        space = 8 + 32 + 32 + 32 + 8 + 8 + 1
    )]
    pub airdrop_state: Account<'info, AirdropState>,
    #[account(
        init,
        payer = authority,
        mint::authority = authority,
        mint::decimals = 6,
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = airdrop_state,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Update<'info> {
    #[account(
        mut, 
        has_one = authority,
        seeds = [b"merkle_tree".as_ref(), airdrop_state.mint.key().to_bytes().as_ref()],
        bump = airdrop_state.bump
    )]
    pub airdrop_state: Account<'info, AirdropState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        has_one = mint,
        seeds = [b"merkle_tree".as_ref(), mint.key().to_bytes().as_ref()],
        bump = airdrop_state.bump
    )]
    pub airdrop_state: Account<'info, AirdropState>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = airdrop_state,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = signer,
    )]
    pub signer_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[account]
pub struct AirdropState {
    pub merkle_root: [u8; 32],
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub airdrop_amount: u64,
    pub amount_claimed: u64,
    pub bump: u8,
}

#[error_code]
pub enum WhitelistError {
    #[msg("Invalid Merkle proof")]
    InvalidProof,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Amount overflow")]
    OverFlow,
}
