/** Local-only 5/10-asset SBF runtime coverage. No quotes or Mainnet writes. */
import {readFileSync,writeFileSync} from 'node:fs';
import {strict as assert} from 'node:assert';
import {AnchorProvider,Program,Wallet,BN} from '@anchor-lang/core';
import {Connection,Keypair,PublicKey,Transaction,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,AddressLookupTableProgram,sendAndConfirmTransaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,createMint,getOrCreateAssociatedTokenAccount,mintTo,getAccount} from '@solana/spl-token';
import * as sdk from '@ssr/sdk';
async function main(){
 const connection=new Connection('http://127.0.0.1:19199','confirmed');assert.equal(new URL(connection.rpcEndpoint).hostname,'127.0.0.1');
 const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/tmp/ssr-liquidity-payer.json','utf8')))),provider=new AnchorProvider(connection,new Wallet(payer),{commitment:'confirmed'}),idl=JSON.parse(readFileSync('target/idl/ssr_protocol.json','utf8')),program=new Program({...idl,address:'8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9'},provider) as any;
 const protocolConfig=sdk.findProtocolConfig(program.programId)[0],results:any[]=[];
 for(const n of [5,10]){
  const addresses=await sdk.deriveNewReserveAddresses(program,program.programId);
  const send=async(ixs:any[],tables:any[]=[])=>{const latest=await connection.getLatestBlockhash('confirmed'),tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:latest.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),...ixs]}).compileToV0Message(tables));assert(tx.serialize().length<=1232);tx.sign([payer]);const signature=await connection.sendRawTransaction(tx.serialize());const result=await connection.confirmTransaction({signature,...latest},'confirmed');if(result.value.err){const details=await connection.getTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});console.error(details?.meta?.logMessages);}assert.equal(result.value.err,null);return signature;};
  await send([await sdk.buildCreateReserveInstruction(program,addresses,payer.publicKey,{metadataUri:'https://example.invalid/local-multiasset.json',mintFeeBps:0,redemptionFeeBps:0,tvlFeeBps:0,feeDestination:payer.publicKey})]);
  const assets:any[]=[],sources:PublicKey[]=[];
  for(let i=0;i<n;i++){
   const mint=await createMint(connection,payer,payer.publicKey,null,6),asset={mint,reserveAsset:sdk.findReserveAsset(addresses.reserve,mint,program.programId)[0],vault:sdk.findReserveVault(addresses.reserve,mint,program.programId)[0],tokenProgram:TOKEN_PROGRAM_ID};
   await program.methods.initializeReserveAsset(10000/n).accounts({protocolConfig,reserve:addresses.reserve,reserveAsset:asset.reserveAsset,assetMint:mint,vault:asset.vault,vaultAuthority:addresses.vaultAuthority,manager:payer.publicKey,tokenProgram:TOKEN_PROGRAM_ID}).rpc();
   const source=await getOrCreateAssociatedTokenAccount(connection,payer,mint,payer.publicKey);await mintTo(connection,payer,mint,source.address,payer,200000000n);assets.push(asset);sources.push(source.address);
  }
  const seed=await sdk.buildSeedReserveInstruction(program,addresses,assets,payer.publicKey,assets.map(()=>100000000n),100000000n);
  const legs=assets.map(a=>({mint:a.mint.toBase58(),decimals:6,reserveAsset:a.reserveAsset.toBase58(),vault:a.vault.toBase58(),vaultBalanceRaw:'100000000',tokenProgram:TOKEN_PROGRAM_ID.toBase58()}));
  const mint=await sdk.buildDirectMultiAssetMintInstructions({program,protocolConfig,protocolFeeDestination:payer.publicKey,reserve:addresses.reserve,reserveTokenMint:addresses.reserveTokenMint,mintAuthority:addresses.mintAuthority,user:payer.publicKey,reserveTokenProgram:TOKEN_2022_PROGRAM_ID,reserveTokenSupplyRaw:'100000000',reserveTokensRequested:1000000n,minReserveTokensOut:995000n,slippageBps:0,assets:legs});
  const feeSettlement=sdk.findFeeSettlement(addresses.reserve,program.programId)[0],feeVaultAuthority=sdk.findFeeVaultAuthority(addresses.reserve,program.programId)[0],feeVault=sdk.findFeeVaultAta(addresses.reserve,addresses.reserveTokenMint,program.programId,TOKEN_2022_PROGRAM_ID),tvlAccrual=sdk.findTvlAccrual(addresses.reserve,program.programId)[0];
  const holder=await getOrCreateAssociatedTokenAccount(connection,payer,addresses.reserveTokenMint,payer.publicKey,false,'confirmed',undefined,TOKEN_2022_PROGRAM_ID);
  const redeem=await program.methods.redeemReserveTokensInKind(new BN(1000000),assets.map(()=>new BN(990000))).accounts({protocolConfig,reserve:addresses.reserve,reserveTokenMint:addresses.reserveTokenMint,mintAuthority:addresses.mintAuthority,redeemer:payer.publicKey,redeemerReserveTokenAccount:holder.address,vaultAuthority:addresses.vaultAuthority,managerFeeRecipients:null,feeSettlement,feeVaultAuthority,feeVault,tvlAccrual,tokenProgram:TOKEN_2022_PROGRAM_ID}).remainingAccounts(assets.flatMap((a,i)=>[{pubkey:a.reserveAsset,isWritable:false,isSigner:false},{pubkey:a.vault,isWritable:true,isSigner:false},{pubkey:sources[i],isWritable:true,isSigner:false},{pubkey:a.mint,isWritable:false,isSigner:false},{pubkey:TOKEN_PROGRAM_ID,isWritable:false,isSigner:false}])).instruction();
  const keys=[...new Map([seed,...mint.instructions,redeem].flatMap(ix=>ix.keys.filter(k=>!k.isSigner).map(k=>[k.pubkey.toBase58(),k.pubkey] as const))).values()];
  const [create,table]=AddressLookupTableProgram.createLookupTable({authority:payer.publicKey,payer:payer.publicKey,recentSlot:await connection.getSlot('finalized')});await send([create]);
  for(let i=0;i<keys.length;i+=20)await send([AddressLookupTableProgram.extendLookupTable({lookupTable:table,authority:payer.publicKey,payer:payer.publicKey,addresses:keys.slice(i,i+20)})]);
  const lookup=(await connection.getAddressLookupTable(table)).value!;while(await connection.getSlot('confirmed')<=lookup.state.lastExtendedSlot)await new Promise(r=>setTimeout(r,400));
  await send([seed],[lookup]);assert.equal((await getAccount(connection,holder.address,'confirmed',TOKEN_2022_PROGRAM_ID)).amount,99500000n);
  await send(mint.instructions,[lookup]);assert.equal((await getAccount(connection,holder.address,'confirmed',TOKEN_2022_PROGRAM_ID)).amount,100495000n);
  const before=await Promise.all(sources.map(a=>getAccount(connection,a)));await send([redeem],[lookup]);const after=await Promise.all(sources.map(a=>getAccount(connection,a)));after.forEach((a,i)=>assert.equal(a.amount-before[i].amount,995000n));
  results.push({assets:n,reserve:addresses.reserve.toBase58(),checks:['seed','mint 50bps floor','redeem 50bps floor','all backing legs funded and returned'],slot:await connection.getSlot('confirmed')});console.log(JSON.stringify(results[results.length-1]));
 }
 writeFileSync('/tmp/ssr-multiasset-runtime.json',JSON.stringify({localOnly:true,results},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
