/** Runtime regression against an isolated LOCAL validator. Never accepts a remote URL. */
import {readFileSync,writeFileSync} from 'node:fs';
import {strict as assert} from 'node:assert';
import {AnchorProvider,Program,Wallet,BN} from '@anchor-lang/core';
import {Connection,Keypair,PublicKey,SystemProgram,Transaction,TransactionInstruction,VersionedTransaction,sendAndConfirmTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,createAccount,getOrCreateAssociatedTokenAccount,mintTo,getAccount,getMint,getTransferFeeConfig,getAssociatedTokenAddressSync,createTransferInstruction} from '@solana/spl-token';
import {prepareRevenuePool,prepareRevenueCollect,permissionAddress,SSR_POOL_PAYER,LIQUIDITY_USDC,SSR_CPMM_CONFIG,creatorShareAddress,decodePool} from '../src/merge/lib/liquidity/raydiumCpmm';
import {prepareLiquidityLifecycle,readLiquidityState} from '../lib/mainnet/liquidityLifecycle';
import {readCompoundSnapshot,createLiveCompoundProviders} from '../lib/mainnet/compoundQuotes';
import {prepareCompound} from '../lib/mainnet/prepareCompound';
import {LiquidityLookupRequired} from '../lib/mainnet/liquidityLookup';
import {prepareLiquiditySetup} from '../lib/mainnet/liquiditySetup';
import {prepareCreateLiquidity} from '../lib/mainnet/createLiquidity';
import * as sdk from '@ssr/sdk';
async function main(){
 const connection=new Connection('http://127.0.0.1:19199','confirmed');
 assert.equal(new URL(connection.rpcEndpoint).hostname,'127.0.0.1');
 const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/tmp/ssr-liquidity-payer.json','utf8')))),wallet=new Wallet(payer),provider=new AnchorProvider(connection,wallet,{commitment:'confirmed'});
 const idl=JSON.parse(readFileSync('target/idl/ssr_protocol.json','utf8'));
 const program=new Program({...idl,address:'8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9'},provider) as any;
 const send=async(ixs:any[])=>{const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),...ixs);return sendAndConfirmTransaction(connection,tx,[payer],{commitment:'confirmed'});};
 const funding=await connection.requestAirdrop(payer.publicKey,20e9);await connection.confirmTransaction(funding,'confirmed');
 const protocolConfig=sdk.findProtocolConfig(program.programId)[0];
 const existing=await program.account.protocolConfig.fetchNullable(protocolConfig);
 if(!existing)await program.methods.initializeProtocol(Keypair.generate().publicKey,12,0,payer.publicKey).accounts({protocolConfig,authority:payer.publicKey,systemProgram:SystemProgram.programId}).rpc();
 const addresses=await sdk.deriveNewReserveAddresses(program,program.programId);
 await send([await sdk.buildCreateReserveInstruction(program,addresses,payer.publicKey,{metadataUri:'https://example.invalid/local-test.json',mintFeeBps:0,redemptionFeeBps:0,tvlFeeBps:0,feeDestination:payer.publicKey})]);
 const mint=await getMint(connection,addresses.reserveTokenMint,'confirmed',TOKEN_2022_PROGRAM_ID);
 assert.equal(getTransferFeeConfig(mint)?.newerTransferFee.transferFeeBasisPoints,15);
 const assetMint=LIQUIDITY_USDC;
 const asset={mint:assetMint,reserveAsset:sdk.findReserveAsset(addresses.reserve,assetMint,program.programId)[0],vault:sdk.findReserveVault(addresses.reserve,assetMint,program.programId)[0],tokenProgram:TOKEN_PROGRAM_ID};
 await program.methods.initializeReserveAsset(10000).accounts({protocolConfig,reserve:addresses.reserve,reserveAsset:asset.reserveAsset,assetMint,vault:asset.vault,vaultAuthority:addresses.vaultAuthority,manager:payer.publicKey,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).rpc();
 const source=await getOrCreateAssociatedTokenAccount(connection,payer,assetMint,payer.publicKey);
 await mintTo(connection,payer,assetMint,source.address,payer,2_000_000_000n);
 await send([await sdk.buildSeedReserveInstruction(program,addresses,[asset] as any,payer.publicKey,[1_000_000_000n],1_000_000_000n)]);
 const holder=await getOrCreateAssociatedTokenAccount(connection,payer,addresses.reserveTokenMint,payer.publicKey,false,'confirmed',undefined,TOKEN_2022_PROGRAM_ID);
 assert.equal(holder.amount,995_000_000n,'seed charges unconditional 0.5% protocol fee');
 const legs=[{mint:assetMint.toBase58(),decimals:6,reserveAsset:asset.reserveAsset.toBase58(),vault:asset.vault.toBase58(),vaultBalanceRaw:'1000000000',tokenProgram:TOKEN_PROGRAM_ID.toBase58()}];
 const minted=await sdk.buildDirectMultiAssetMintInstructions({program,protocolConfig,protocolFeeDestination:payer.publicKey,reserve:addresses.reserve,reserveTokenMint:addresses.reserveTokenMint,mintAuthority:addresses.mintAuthority,user:payer.publicKey,reserveTokenProgram:TOKEN_2022_PROGRAM_ID,reserveTokenSupplyRaw:'1000000000',reserveTokensRequested:10_000_000n,minReserveTokensOut:9_950_000n,slippageBps:0,assets:legs});
 await send(minted.instructions);
 assert.equal((await getAccount(connection,holder.address,'confirmed',TOKEN_2022_PROGRAM_ID)).amount,1_004_950_000n);
 const feeSettlement=sdk.findFeeSettlement(addresses.reserve,program.programId)[0],feeVaultAuthority=sdk.findFeeVaultAuthority(addresses.reserve,program.programId)[0],feeVault=sdk.findFeeVaultAta(addresses.reserve,addresses.reserveTokenMint,program.programId,TOKEN_2022_PROGRAM_ID),tvlAccrual=sdk.findTvlAccrual(addresses.reserve,program.programId)[0];
 const before=(await getAccount(connection,source.address)).amount;
 await program.methods.redeemReserveTokensInKind(new BN(10_000_000),[new BN(9_940_000)]).accounts({protocolConfig,reserve:addresses.reserve,reserveTokenMint:addresses.reserveTokenMint,mintAuthority:addresses.mintAuthority,redeemer:payer.publicKey,redeemerReserveTokenAccount:holder.address,vaultAuthority:addresses.vaultAuthority,managerFeeRecipients:null,feeSettlement,feeVaultAuthority,feeVault,tvlAccrual,tokenProgram:TOKEN_2022_PROGRAM_ID,systemProgram:SystemProgram.programId}).remainingAccounts([{pubkey:asset.reserveAsset,isWritable:false,isSigner:false},{pubkey:asset.vault,isWritable:true,isSigner:false},{pubkey:source.address,isWritable:true,isSigner:false},{pubkey:assetMint,isWritable:false,isSigner:false},{pubkey:TOKEN_PROGRAM_ID,isWritable:false,isSigner:false}]).rpc();
 const received=(await getAccount(connection,source.address)).amount-before;
 assert.equal(received,9_950_000n,'redemption charges unconditional 0.5% protocol fee');
 // A fabricated local permission lets the ephemeral test payer exercise the
 // exact public Raydium binary. This does not grant any Mainnet permission.
 const localPermission=await connection.getAccountInfo(permissionAddress(payer.publicKey),'confirmed');
 assert(localPermission);const preparedPermission={...localPermission,data:Buffer.from(localPermission.data)};
 SSR_POOL_PAYER.toBuffer().copy(preparedPermission.data,8);
 const facade:any={getAccountInfo:(key:PublicKey)=>connection.getAccountInfo(key,'confirmed'),getMultipleAccountsInfo:async(keys:PublicKey[],commitment:any)=>Promise.all(keys.map(k=>k.equals(permissionAddress())?preparedPermission:connection.getAccountInfo(k,'confirmed')))};
 const localApprovedFunding=await connection.requestAirdrop(SSR_POOL_PAYER,20e9);await connection.confirmTransaction(localApprovedFunding,'confirmed');
 const creationConnection=new Proxy(connection,{get:(target,property)=>property==='getAccountInfo'?(key:PublicKey)=>target.getAccountInfo(key,'confirmed'):property==='getMultipleAccountsInfo'?(keys:PublicKey[])=>target.getMultipleAccountsInfo(keys,'confirmed'):typeof (target as any)[property]==='function'?(target as any)[property].bind(target):(target as any)[property]});
 const creationDeps={connection:creationConnection,program,programId:program.programId,executionEnabled:false,prices:async()=>new Map()};
 const creationInput={reserve:addresses.reserve,actor:payer.publicKey,usdcRaw:10_000_000n,maximumSolRaw:100_000_000n,buyTaxBps:100,sellTaxBps:100,lock:'unlocked' as const};
 let creationTable:PublicKey|undefined,needed:PublicKey[]=[];
 try{await prepareCreateLiquidity(creationDeps,creationInput);}catch(e){assert(e instanceof LiquidityLookupRequired);needed=e.addresses.map(a=>new PublicKey(a));}
 assert(needed.length>0);
 for(let i=0;i<8;i++){const setup=await prepareLiquiditySetup(creationDeps,{reserve:addresses.reserve,actor:payer.publicKey,addresses:needed,table:creationTable,maximumSolRaw:50_000_000n});creationTable=new PublicKey(setup.table);if(setup.complete)break;const tx=VersionedTransaction.deserialize(Buffer.from(setup.prepared!.transactionBase64,'base64'));tx.sign([payer]);const signature=await connection.sendRawTransaction(tx.serialize());const confirmed=await connection.confirmTransaction({signature,blockhash:setup.prepared!.blockhash,lastValidBlockHeight:setup.prepared!.lastValidBlockHeight},'confirmed');assert.equal(confirmed.value.err,null);}
 assert(creationTable);const creationSlot=(await connection.getAddressLookupTable(creationTable)).value!.state.lastExtendedSlot;while(await connection.getSlot('confirmed')<=creationSlot)await new Promise(r=>setTimeout(r,400));
 const creation=await prepareCreateLiquidity(creationDeps,{...creationInput,lookupTables:[creationTable]});
 assert(creation.simulation.passed);assert(creation.requiredSigners.includes(SSR_POOL_PAYER.toBase58()));assert(creation.requiredSigners.includes(payer.publicKey.toBase58()));assert.equal(creation.review.initialLpOwner,payer.publicKey.toBase58());assert(BigInt(creation.review.reserveDebitRaw)>10_000_000n);assert.equal(await connection.getAccountInfo(new PublicKey(creation.pool)),null,'creation was simulated without a real approved-payer signature');
 const built=await prepareRevenuePool({connection:facade,programId:program.programId,reserve:addresses.reserve,reserveMint:addresses.reserveTokenMint,manager:payer.publicKey,payer:SSR_POOL_PAYER,protocolConfig,reserveAmountRaw:100_000_000n,usdcAmountRaw:100_000_000n,openTime:0n,buyTaxBps:100,sellTaxBps:100});
 const usdc=await getOrCreateAssociatedTokenAccount(connection,payer,LIQUIDITY_USDC,payer.publicKey);
 await mintTo(connection,payer,LIQUIDITY_USDC,usdc.address,payer,1_000_000_000n);
 const replacements=new Map<string,PublicKey>([[SSR_POOL_PAYER.toBase58(),payer.publicKey],[permissionAddress().toBase58(),permissionAddress(payer.publicKey)]]);
 for(const [mint,tokenProgram] of [[LIQUIDITY_USDC,TOKEN_PROGRAM_ID],[addresses.reserveTokenMint,TOKEN_2022_PROGRAM_ID],[built.lpMint,TOKEN_PROGRAM_ID]] as const)replacements.set(getAssociatedTokenAddressSync(mint,SSR_POOL_PAYER,false,tokenProgram).toBase58(),getAssociatedTokenAddressSync(mint,payer.publicKey,false,tokenProgram));
 const initialize=new TransactionInstruction({programId:built.instructions[0].programId,data:built.instructions[0].data,keys:built.instructions[0].keys.map(k=>({...k,pubkey:replacements.get(k.pubkey.toBase58())??k.pubkey}))});
 await send([initialize]);await send([built.instructions[1]]);
 const pool=decodePool(await connection.getAccountInfo(built.pool),addresses.reserveTokenMint,built.revenue);
 const lpAccount=getAssociatedTokenAddressSync(built.lpMint,payer.publicKey),beforeLp=(await getAccount(connection,lpAccount)).amount;
 assert(beforeLp>0n);
 const approvedLp=await getOrCreateAssociatedTokenAccount(connection,payer,built.lpMint,SSR_POOL_PAYER);
 const finalize=await program.methods.finalizeLiquidityPool().accounts({reserve:addresses.reserve,revenue:built.revenue,pool:built.pool,lpMint:built.lpMint,destination:lpAccount,payerLp:approvedLp.address}).instruction();
 await send([finalize]);
 await send([createTransferInstruction(lpAccount,approvedLp.address,payer.publicKey,1n)]);
 await assert.rejects(()=>send([finalize]),/LiquidityRevenueValidationFailed/);
 // One LP unit remains with the synthetic approved payer to prove the guard;
 // no test attempts to sign that real Mainnet public key.
 const lockStartingLp=(await getAccount(connection,lpAccount)).amount;

 const chainTime=async()=>{const t=await connection.getBlockTime(await connection.getSlot('confirmed'));assert(t);return BigInt(t);};
 const lock=await sdk.buildLockLiquidityTranche(program,{reserve:addresses.reserve,pool:built.pool,lpMint:built.lpMint,creator:payer.publicKey,owner:payer.publicKey,nonce:1n,amount:1_000_000n,unlockTs:(await chainTime())+60n});
 await send([lock.instruction]);
 const withdraw=await sdk.buildWithdrawLiquidityTranche(program,{tranche:lock.tranche,owner:payer.publicKey,lpMint:built.lpMint});
 await assert.rejects(()=>send([withdraw]),/LiquidityPrincipalLocked|6075|0x17bb/);
 const state=await program.account.liquidityTranche.fetch(lock.tranche);
 await assert.rejects(async()=>send([await sdk.buildExtendLiquidityTranche(program,{tranche:lock.tranche,creator:payer.publicKey,owner:payer.publicKey,unlockTs:BigInt(state.unlockTs.toString())-1n})]),/LiquidityLockTermInvalid|6071|0x17b7/);
 await send([await sdk.buildExtendLiquidityTranche(program,{tranche:lock.tranche,creator:payer.publicKey,owner:payer.publicKey,unlockTs:BigInt(state.unlockTs.toString())+60n})]);
 const permanent=await sdk.buildMakeLiquidityTranchePermanent(program,{tranche:lock.tranche,creator:payer.publicKey,owner:payer.publicKey,pool:built.pool,lpMint:built.lpMint,vault0:pool.vault0,vault1:pool.vault1});
 const redirected=new TransactionInstruction({programId:permanent.programId,data:permanent.data,keys:permanent.keys.map(k=>k.pubkey.equals(pool.vault0)?{...k,pubkey:pool.vault1}:k)});
 await assert.rejects(()=>send([redirected]),/LiquidityRevenueValidationFailed/);
 assert.equal((await getAccount(connection,lock.escrow)).amount,1_000_000n);
 await send([permanent]);
 assert.equal((await program.account.liquidityTranche.fetch(lock.tranche)).permanent,true);
 assert.equal((await getAccount(connection,lock.escrow)).amount,0n);
 const feeKey=sdk.nativeLockAddresses(lock.tranche,payer.publicKey,built.lpMint,program.programId);
 assert.equal((await getAccount(connection,feeKey.nftAccount)).amount,1n);
 assert.equal((await getAccount(connection,feeKey.lockLpVault)).amount,1_000_000n);
 await assert.rejects(()=>send([withdraw]),/LiquidityPrincipalLocked|6075|0x17bb/);
 const expiry=(await chainTime())+4n,short=await sdk.buildLockLiquidityTranche(program,{reserve:addresses.reserve,pool:built.pool,lpMint:built.lpMint,creator:payer.publicKey,owner:payer.publicKey,nonce:2n,amount:2_000_000n,unlockTs:expiry});
 await send([short.instruction]);
 const deadline=Date.now()+20_000;while(await chainTime()<expiry){assert(Date.now()<deadline,'local clock did not advance');await new Promise(r=>setTimeout(r,400));}
 const shortWithdraw=await sdk.buildWithdrawLiquidityTranche(program,{tranche:short.tranche,owner:payer.publicKey,lpMint:built.lpMint});
 const fakeEscrow=await createAccount(connection,payer,built.lpMint,short.tranche,Keypair.generate());
 const substituted=new TransactionInstruction({programId:shortWithdraw.programId,data:shortWithdraw.data,keys:shortWithdraw.keys.map(k=>k.pubkey.equals(short.escrow)?{...k,pubkey:fakeEscrow}:k)});
 await assert.rejects(()=>send([substituted]),/ConstraintRaw/);
 const wrongDestination=await createAccount(connection,payer,built.lpMint,Keypair.generate().publicKey,Keypair.generate());
 const redirectedWithdrawal=new TransactionInstruction({programId:shortWithdraw.programId,data:shortWithdraw.data,keys:shortWithdraw.keys.map(k=>k.pubkey.equals(lpAccount)?{...k,pubkey:wrongDestination}:k)});
 await assert.rejects(()=>send([redirectedWithdrawal]),/ConstraintRaw/);
 await send([shortWithdraw]);
 assert.equal((await getAccount(connection,lpAccount)).amount,lockStartingLp-1_000_000n);
 await assert.rejects(()=>send([shortWithdraw]),/LiquidityPrincipalLocked|6075|0x17bb/);
 const poolAccounts={pool:built.pool,...pool};
 const treasuryUsdcBefore=(await getAccount(connection,usdc.address)).amount;
 await send([sdk.buildSwapWithProjectTax({programId:program.programId,user:payer.publicKey,protocolConfig,reserve:addresses.reserve,userUsdc:usdc.address,protocolDestination:usdc.address,creatorDestination:usdc.address,raydiumProgram:initialize.programId,nativeSwapAccounts:sdk.cpmmSwapAccounts(poolAccounts,payer.publicKey,SSR_CPMM_CONFIG,LIQUIDITY_USDC),buy:true,amountIn:1_000_000n,minimumNetOut:1n})]);
 assert((await getAccount(connection,usdc.address)).amount<treasuryUsdcBefore);
 const collector=Keypair.generate(),airdrop=await connection.requestAirdrop(collector.publicKey,1e9);await connection.confirmTransaction(airdrop,'confirmed');
 const collect=await prepareRevenueCollect({connection:facade,programId:program.programId,reserve:addresses.reserve,reserveMint:addresses.reserveTokenMint,pool:built.pool,payer:collector.publicKey,protocolConfig,protocolTreasury:payer.publicKey,creatorTreasury:payer.publicKey});
 assert(collect.netUsdcRaw>0n);
 const beforeCollect=(await getAccount(connection,usdc.address)).amount;
 await sendAndConfirmTransaction(connection,new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),...collect.instructions),[collector],{commitment:'confirmed'});
 assert.equal((await getAccount(connection,usdc.address)).amount-beforeCollect,collect.netUsdcRaw);
 // Direct external collection can leave funds in the router; Collect must also
 // distribute these even when the native pool has no unclaimed creator fees.
 const staging=getAssociatedTokenAddressSync(LIQUIDITY_USDC,built.revenue,true);
 await mintTo(connection,payer,LIQUIDITY_USDC,staging,payer,5700n);
 const stagedCollect=await prepareRevenueCollect({connection:facade,programId:program.programId,reserve:addresses.reserve,reserveMint:addresses.reserveTokenMint,pool:built.pool,payer:collector.publicKey,protocolConfig,protocolTreasury:payer.publicKey,creatorTreasury:payer.publicKey});
 assert.equal(stagedCollect.grossUsdcRaw,0n);assert.equal(stagedCollect.netUsdcRaw,5700n);
 await sendAndConfirmTransaction(connection,new Transaction().add(...stagedCollect.instructions),[collector],{commitment:'confirmed'});
 assert.equal((await getAccount(connection,staging)).amount,0n);
 const deps={connection,program,programId:program.programId,executionEnabled:false};
 const beforeLifecycle=await readLiquidityState(deps,addresses.reserve);
 const runPrepared=async(prepared:any)=>{assert.equal(prepared.executionEnabled,false);const tx=VersionedTransaction.deserialize(Buffer.from(prepared.transactionBase64,'base64'));tx.sign([payer]);const sig=await connection.sendRawTransaction(tx.serialize());const outcome=await connection.confirmTransaction({signature:sig,blockhash:prepared.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight},'confirmed');if(outcome.value.err){const details=await connection.getTransaction(sig,{commitment:'confirmed',maxSupportedTransactionVersion:0});console.error(details?.meta?.logMessages);}assert.equal(outcome.value.err,null,'prepared transaction must succeed on chain');};
 const added=await prepareLiquidityLifecycle(deps,{reserve:addresses.reserve,actor:payer.publicKey,action:'add',maximumUsdcRaw:100_000n,maximumReserveRaw:100_000n,slippageBps:50,lock:'unlocked',maximumSolRaw:50_000_000n});
 await program.methods.setProtocolPaused(true).accounts({protocolConfig,authority:payer.publicKey}).rpc();
 await assert.rejects(()=>runPrepared(added),/ProtocolPaused|paused/i);
 assert.equal((await getAccount(connection,lpAccount)).amount,beforeLifecycle.lpBalance);
 await program.methods.setProtocolPaused(false).accounts({protocolConfig,authority:payer.publicKey}).rpc();
 await runPrepared(added);
 const afterAdd=await readLiquidityState(deps,addresses.reserve);assert.equal(afterAdd.lpBalance-beforeLifecycle.lpBalance,BigInt(added.review.lpAddedRaw));
 await program.methods.setProtocolPaused(true).accounts({protocolConfig,authority:payer.publicKey}).rpc();
 const removed=await prepareLiquidityLifecycle(deps,{reserve:addresses.reserve,actor:payer.publicKey,action:'withdraw',lpAmountRaw:BigInt(added.review.lpAddedRaw),slippageBps:50,lock:'unlocked',maximumSolRaw:50_000_000n});
 await runPrepared(removed);assert.equal((await readLiquidityState(deps,addresses.reserve)).lpBalance,beforeLifecycle.lpBalance);
 await program.methods.setProtocolPaused(false).accounts({protocolConfig,authority:payer.publicKey}).rpc();
 const addedLocked=await prepareLiquidityLifecycle(deps,{reserve:addresses.reserve,actor:payer.publicKey,action:'add',maximumUsdcRaw:100_000n,maximumReserveRaw:100_000n,slippageBps:50,lock:'1-month',maximumSolRaw:50_000_000n});
 await runPrepared(addedLocked);assert.equal((await readLiquidityState(deps,addresses.reserve)).lpBalance,beforeLifecycle.lpBalance);
 assert.equal((await getAccount(connection,getAssociatedTokenAddressSync(built.lpMint,new PublicKey(addedLocked.tranche!),true))).amount,BigInt(addedLocked.review.lpAddedRaw));
 const permanentInput={reserve:addresses.reserve,actor:payer.publicKey,action:'add' as const,maximumUsdcRaw:100_000n,maximumReserveRaw:100_000n,slippageBps:50,lock:'permanent' as const,maximumSolRaw:50_000_000n};
 let setupAddresses:PublicKey[]=[];try{await prepareLiquidityLifecycle(deps,permanentInput);}catch(e){assert(e instanceof LiquidityLookupRequired);setupAddresses=e.addresses.map(a=>new PublicKey(a));}
 assert(setupAddresses.length>0,'permanent addition needs compressed account references');
 let table:PublicKey|undefined;
 for(let i=0;i<8;i++){const setup=await prepareLiquiditySetup(deps,{reserve:addresses.reserve,actor:payer.publicKey,addresses:setupAddresses,table,maximumSolRaw:50_000_000n});table=new PublicKey(setup.table);if(setup.complete)break;await runPrepared(setup.prepared);}
 assert(table);const tableSlot=(await connection.getAddressLookupTable(table)).value!.state.lastExtendedSlot;while(await connection.getSlot('confirmed')<=tableSlot)await new Promise(r=>setTimeout(r,400));
 const permanentAdd=await prepareLiquidityLifecycle(deps,{...permanentInput,lookupTables:[table]});
 await runPrepared(permanentAdd);assert.equal((await program.account.liquidityTranche.fetch(new PublicKey(permanentAdd.tranche!))).permanent,true);
 const snapshot=await readCompoundSnapshot(deps,{reserve:addresses.reserve,pool:built.pool,creator:payer.publicKey,budgetUsdcRaw:1_000_000n,slippageBps:50,lpDestination:lpAccount,lockPolicyId:'1-month'});
 let acquisitionPlan:any;const providers=createLiveCompoundProviders(snapshot,{jupiterApiKey:'',prices:new Map(),recordPlan:(_id,p)=>acquisitionPlan=p});
 const comparison=await sdk.compareCompoundRoutes(snapshot.context,{pool:providers.pool,mint:async()=>{throw new Error('Local test selects the pool route');}}),quote=comparison.quotes.find(q=>q.route==='pool')!;
 assert(quote);const approval=sdk.approveCompoundRoute(comparison,'pool',payer.publicKey.toBase58());
 const compounded=await prepareCompound(deps,{quote,approval,acquisitionPlan,lookupTables:[table]});await runPrepared(compounded);
 const mintSnapshot=await readCompoundSnapshot(deps,{reserve:addresses.reserve,pool:built.pool,creator:payer.publicKey,budgetUsdcRaw:1_000_000n,slippageBps:50,lpDestination:lpAccount,lockPolicyId:'permanent'});
 const plans=new Map<string,any>(),mintProviders=createLiveCompoundProviders(mintSnapshot,{jupiterApiKey:'',prices:new Map(),recordPlan:(id,p)=>plans.set(id,p)});
 const mintComparison=await sdk.compareCompoundRoutes(mintSnapshot.context,mintProviders),mintQuote=mintComparison.quotes.find(q=>q.route==='mint')!;assert(mintQuote,'USDC-backed Reserve must expose the native mint route');
 const mintApproval=sdk.approveCompoundRoute(mintComparison,'mint',payer.publicKey.toBase58());
 let mintPrepared:any;
 try{mintPrepared=await prepareCompound(deps,{quote:mintQuote,approval:mintApproval,acquisitionPlan:plans.get(mintQuote.planFingerprint),lookupTables:[table]});}catch(e){assert(e instanceof LiquidityLookupRequired);const needed=e.addresses.map(a=>new PublicKey(a));for(let i=0;i<8;i++){const setup=await prepareLiquiditySetup(deps,{reserve:addresses.reserve,actor:payer.publicKey,addresses:needed,table,maximumSolRaw:50_000_000n});if(setup.complete)break;await runPrepared(setup.prepared);}const extended=(await connection.getAddressLookupTable(table)).value!.state.lastExtendedSlot;while(await connection.getSlot('confirmed')<=extended)await new Promise(r=>setTimeout(r,400));
  // Setup can outlive the old quote. Fresh state and an explicit new local
  // creator choice are required; never reuse an expired acquisition approval.
  const fresh=await readCompoundSnapshot(deps,{reserve:addresses.reserve,pool:built.pool,creator:payer.publicKey,budgetUsdcRaw:1_000_000n,slippageBps:50,lpDestination:lpAccount,lockPolicyId:'permanent'}),freshPlans=new Map<string,any>(),freshProviders=createLiveCompoundProviders(fresh,{jupiterApiKey:'',prices:new Map(),recordPlan:(id,p)=>freshPlans.set(id,p)}),freshComparison=await sdk.compareCompoundRoutes(fresh.context,freshProviders),freshQuote=freshComparison.quotes.find(q=>q.route==='mint')!;assert(freshQuote);mintPrepared=await prepareCompound(deps,{quote:freshQuote,approval:sdk.approveCompoundRoute(freshComparison,'mint',payer.publicKey.toBase58()),acquisitionPlan:freshPlans.get(freshQuote.planFingerprint),lookupTables:[table]});}
 await runPrepared(mintPrepared);
 const report={localOnly:true,program:program.programId.toBase58(),reserve:addresses.reserve.toBase58(),checks:['initialize protocol','create Token-2022 Reserve','15bps transfer fee','register backing asset','seed with 50bps floor','mint with 50bps floor','redeem with 50bps floor','atomic approved-payer funding and initial LP return simulation','NAV-priced creation including both transfer fees','native Raydium permissioned pool (local fixture permission)','fixed creator revenue router','initial LP return finalizer','stranded LP ownership rejected','timed LP custody','early withdrawal rejected','shortening rejected','extend lock','native permanent CPI with PDA Fee Key mint','native Fee Key at creator treasury','permanent-lock vault substitution rejected','permanent principal cannot withdraw','expired tranche withdrawal','noncanonical escrow substitution rejected','withdrawal redirection rejected','double withdrawal rejected','native taxed buy with treasury self-recipient','permissionless native Collect and fixed distribution','staging-only Collect after external harvest','lifecycle snapshot and simulated addition','on-chain pause after preparation rejects addition','simulated LP withdrawal remains available during pause','atomic addition into a timed tranche','resumable simulated address-table setup','atomic addition into a native permanent lock','approved pool-route Compound into timed custody','approved primary-mint Compound into a native permanent lock'],slot:await connection.getSlot('confirmed')};
 writeFileSync('/tmp/ssr-local-runtime.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
