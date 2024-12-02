import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MerkleTreeTokenClaimer } from "../target/types/merkle_tree_token_claimer";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { HashingAlgorithm, MerkleTree } from "svm-merkle-tree";
import { ASSOCIATED_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";


describe("merkle-tree-token-claimer", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = anchor.Wallet.local();

  const program = anchor.workspace.MerkleTreeTokenClaimer as Program<MerkleTreeTokenClaimer>;

  let authority = wallet.payer;
  let mint = Keypair.generate();
  let newAddress: Keypair;
  let airdropState: PublicKey;
  let merkleTree: MerkleTree;
  let vault: PublicKey;
  let newData: AirdropTokenData;

  interface AirdropTokenData {
    address: PublicKey;
    amount: number;
    isClaimed: boolean;
  }
  let merkleTreeData: AirdropTokenData[];

  before(async () => {
    airdropState = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), mint.publicKey.toBuffer()], program.programId)[0];
    vault = await getAssociatedTokenAddress(mint.publicKey, airdropState, true);

    // Airdrop SOL to authority
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.publicKey,
          toPubkey: authority.publicKey,
          lamports: 10 * LAMPORTS_PER_SOL,
        })
      ), 
      []
    );

    // Generate 100 random addresses and amount
    merkleTreeData = Array.from({ length: 100 }, () => ({
      address: Keypair.generate().publicKey,
      amount: Math.floor(Math.random() * 1000),           // Example random amount
      isClaimed: false,                                   // Default value for isClaimed
    }));
    
    // Create Merkle Tree
    merkleTree = new MerkleTree(HashingAlgorithm.Keccak, 32);
    merkleTreeData.forEach((entry) => {
      // Serialize address, amount, and isClaimed in binary format
      const entryBytes = Buffer.concat([
        entry.address.toBuffer(),
        Buffer.from(new Uint8Array(new anchor.BN(entry.amount).toArray('le', 8))),
        Buffer.from([entry.isClaimed ? 1 : 0]),
      ]);
      merkleTree.add_leaf(entryBytes);
    });
    merkleTree.merklize();
    
  });

  it("Initialize airdrop data", async () => {
    const merkleRoot = Array.from(merkleTree.get_merkle_root());
    const totalAirdropAmount = merkleTreeData.reduce((sum, entry) => sum + entry.amount, 0);

    await program.methods.initializeAirdropData(merkleRoot, new anchor.BN(totalAirdropAmount))
      .accountsPartial({
        airdropState,
        mint: mint.publicKey,
        vault,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      })
      .signers([authority, mint])
      .rpc();

    const account = await program.account.airdropState.fetch(airdropState);
    expect(account.merkleRoot).to.deep.equal(merkleRoot);
    expect(account.authority.toString()).to.equal(authority.publicKey.toString());
  });

  it("Update root", async () => {
    const newData = {
      address: Keypair.generate().publicKey,
      amount: Math.floor(Math.random() * 1000),           // Example random amount
      isClaimed: false,                                   // Default value for isClaimed
    };
    merkleTreeData.push(newData); 
    const entryBytes = Buffer.concat([
      newData.address.toBuffer(), // PublicKey as bytes
      Buffer.from(new Uint8Array(new anchor.BN(newData.amount).toArray('le', 8))), // Amount as little-endian
      Buffer.from([newData.isClaimed ? 1 : 0]), // isClaimed as 1 byte
    ]);
    merkleTree.add_leaf(entryBytes);
    merkleTree.merklize();

    const newMerkleRoot = Array.from(merkleTree.get_merkle_root());

    await program.methods.updateTree(newMerkleRoot)
      .accountsPartial({
        airdropState: airdropState,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const account = await program.account.airdropState.fetch(airdropState);
    expect(account.merkleRoot).to.deep.equal(newMerkleRoot);
  });

  it("Perform claim with whitelisted address", async () => {
    newAddress = Keypair.generate();
    newData = {
      address: newAddress.publicKey,
      amount: Math.floor(Math.random() * 1000),           // Example random amount
      isClaimed: false,                                   // Default value for isClaimed
    }
    merkleTreeData.push(newData); 
    const entryBytes = Buffer.concat([
      newData.address.toBuffer(), // PublicKey as bytes
      Buffer.from(new Uint8Array(new anchor.BN(newData.amount).toArray('le', 8))), // Amount as little-endian
      Buffer.from([newData.isClaimed ? 1 : 0]), // isClaimed as 1 byte
    ]);
    merkleTree.add_leaf(entryBytes);
    merkleTree.merklize();
  
    const newMerkleRoot = Array.from(merkleTree.get_merkle_root());
  
    await program.methods.updateTree(newMerkleRoot)
      .accountsPartial({
        airdropState: airdropState,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();
  
    const index = merkleTreeData.findIndex(data => data.address.equals(newAddress.publicKey));
    if (index === -1) {
      throw new Error("Address not found in Merkle tree data");
    }

    const proof = merkleTree.merkle_proof_index(index);
    const proofArray = Buffer.from(proof.get_pairing_hashes());

    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.publicKey,
          toPubkey: newAddress.publicKey,
          lamports: 10 * LAMPORTS_PER_SOL,
        })
      ), 
      []
    );
  
    try {
      await program.methods.claimAirdrop(new anchor.BN(newData.amount), proofArray, new anchor.BN(index))
        .accountsPartial({
          airdropState,
          mint: mint.publicKey,
          vault,
          signerAta: await getAssociatedTokenAddress(mint.publicKey, newAddress.publicKey),
          signer: newAddress.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        })
        .signers([newAddress])
        .rpc();
      console.log("Action performed successfully for whitelisted address");
    } catch (error) {
      console.error("Error performing action:", error);
      throw error;
    }
  });

  it("Fail to claim after wallet already claimed", async () => {
    const index = merkleTreeData.findIndex(data => data.address.equals(newAddress.publicKey));
    if (index === -1) {
      throw new Error("Address not found in Merkle tree data");
    }

    const proof = merkleTree.merkle_proof_index(index);
    const proofArray = Buffer.from(proof.get_pairing_hashes());

    try {
      await program.methods.claimAirdrop(new anchor.BN(newData.amount), proofArray, new anchor.BN(index))
        .accountsPartial({
          airdropState,
          mint: mint.publicKey,
          vault,
          signerAta: await getAssociatedTokenAddress(mint.publicKey, newAddress.publicKey),
          signer: newAddress.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        })
        .signers([newAddress])
        .rpc();
      expect.fail("Action should have failed for non-whitelisted address");
    } catch (error: any) {
      expect(error.error.errorMessage).to.equal("Invalid Merkle proof");
    }
  });

  it("Fail action with non-whitelisted address", async () => {
    // Generate a non-whitelisted address
    const nonWhitelistedKeypair = Keypair.generate();
  
    // Use the proof of the first whitelisted address
    const index = 0; // Assuming the first entry in `merkleTreeData` is whitelisted
    const whitelistedData = merkleTreeData[index];
    
    const proof = merkleTree.merkle_proof_index(index);
    const proofArray = Buffer.from(proof.get_pairing_hashes());

    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.publicKey,
          toPubkey: nonWhitelistedKeypair.publicKey,
          lamports: 10 * LAMPORTS_PER_SOL,
        })
      ), 
      []
    );
  
    // Attempt to claim with the non-whitelisted address
    try {
      await program.methods.claimAirdrop(
        new anchor.BN(whitelistedData.amount), // Use the whitelisted amount
        proofArray,
        new anchor.BN(index)
      )
        .accountsPartial({
          airdropState,
          mint: mint.publicKey,
          vault,
          signerAta: await getAssociatedTokenAddress(mint.publicKey, nonWhitelistedKeypair.publicKey),
          signer: nonWhitelistedKeypair.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        })
        .signers([nonWhitelistedKeypair])
        .rpc();
  
      // If no error is thrown, the test should fail
      expect.fail("Action should have failed for non-whitelisted address");
    } catch (error: any) {
      // Check that the correct error is thrown
      expect(error.error.errorMessage).to.equal("Invalid Merkle proof");
    }
  });
  

  it("Fail to update root with non-authority signer", async () => {
    const newMerkleRoot = Array.from(merkleTree.get_merkle_root());
    const nonAuthority = Keypair.generate();

    try {
      await program.methods.updateTree(newMerkleRoot)
        .accountsPartial({
          airdropState: airdropState,
          authority: nonAuthority.publicKey,
        })
        .signers([nonAuthority])
        .rpc();
      
      expect.fail("Update should have failed for non-authority signer");
    } catch (error: any) {
      expect(error.error.errorMessage).to.equal("A has one constraint was violated");
    }
  });
});
