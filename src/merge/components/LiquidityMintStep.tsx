/**
 * When the creator treasury holds fewer Reserve Tokens than a pool launch or
 * addition needs, mint only the missing amount first -- through the normal Mint
 * flow (same server build, fee, swaps, double-mint guard and delivery check),
 * never a separate code path. The tokens land in the connected wallet, so this
 * is offered only when that wallet IS the creator treasury.
 */
import {useState} from 'react';
import {useConnection,useWallet} from '@solana/wallet-adapter-react';
import {PublicKey} from '@solana/web3.js';
import {Coins} from 'lucide-react';
import {fetchReserveOnChain,findProtocolConfig,type ZapAssetLeg} from '@ssr/sdk';
import type {DTR} from '@/lib/types';
import {formatUsdc} from '@/lib/calculations';
import {executeMultiAssetBuyMainnet,MultiAssetBuyError,type MultiAssetBuyProgressEvent} from '@/lib/multiAssetBuyClient';
import {AmbiguousConfirmationError} from '@/lib/rpcResilience';
import {MAINNET_TREASURY_VAULT,MAINNET_USDC_MINT,SSR_PROGRAM_ID} from '@/lib/solana-config';
import {fromRaw,type LiveLiquidityState} from '../lib/liquidity/liveLiquidityClient';
import type {LiquidityMintPlan} from '../lib/liquidity/liquidityMintPlan';
import {Button} from './ui/button';

const progressText=(e:MultiAssetBuyProgressEvent,ticker:string)=>{
 switch(e.phase){
  case 'building':return 'Preparing the mint…';
  case 'single-transaction':return `One approval: your USDC is swapped into the reserve assets and ${ticker} is minted.`;
  case 'enabling-one-approval-trading':return 'One-time setup for this Reserve first (a small separate approval).';
  case 'signing-batch':return `Your wallet will show ${e.total} transactions to approve together: ${e.swaps} swap USDC into the reserve assets, then one mints ${ticker}.`;
  case 'swapping':return `Swapping USDC into reserve asset ${e.index+1} of ${e.total}…`;
  case 'minting':return `Minting ${ticker}…`;
  case 'confirming':return 'Waiting for Solana to confirm…';
  default:return 'Approve in your wallet.';
 }
};

export function LiquidityMintStep({dtr,state,plan,disabled,onMinted}:{dtr:DTR;state:LiveLiquidityState;plan:LiquidityMintPlan;disabled:boolean;onMinted:()=>void}){
 const {connection}=useConnection(),wallet=useWallet();
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[recover,setRecover]=useState(false);
 const chain=dtr.onChain!,amount=Number(fromRaw(plan.mintRaw,state.reserveDecimals)).toLocaleString(undefined,{maximumFractionDigits:4});
 const isTreasury=wallet.publicKey?.toBase58()===state.treasury;
 const mint=async()=>{
  if(busy||!wallet.publicKey)return;setBusy(true);setMessage('');setRecover(false);
  try{
   const reserve=new PublicKey(chain.reserve),live=await fetchReserveOnChain(connection,SSR_PROGRAM_ID,reserve,chain.assets.map(a=>new PublicKey(a.mint)));
   if(!live)throw new Error("Could not read this Reserve's live state. Try again shortly.");
   const assets:ZapAssetLeg[]=live.assets.map(a=>({mint:a.assetMint,decimals:a.decimals,reserveAsset:a.reserveAsset,vault:a.vault,vaultBalanceRaw:a.vaultBalanceRaw,tokenProgram:a.tokenProgram}));
   const {alreadyMinted}=await executeMultiAssetBuyMainnet({connection,wallet,protocolConfig:findProtocolConfig(SSR_PROGRAM_ID)[0],protocolFeeDestination:new PublicKey(MAINNET_TREASURY_VAULT),
    reserve,reserveTokenMint:new PublicKey(chain.reserveTokenMint),mintAuthority:new PublicKey(chain.mintAuthority),assets,reserveTokenSupplyRaw:live.reserveTokenSupplyRaw,
    reserveTokensRequested:plan.mintRaw,effectiveMintFeeTotalBps:BigInt(chain.effectiveMintFeeTotalBps??chain.mintFeeBps??0),assetPricesUsd:chain.assetPricesUsd??{},
    onProgress:e=>setMessage(progressText(e,dtr.ticker))});
   setMessage(alreadyMinted?`An earlier attempt had already minted the ${dtr.ticker}. Preparing the liquidity review…`:`Minted ${amount} ${dtr.ticker}. Preparing the liquidity review…`);
   onMinted();
  }catch(e){
   if(e instanceof AmbiguousConfirmationError){setMessage(`Solana has not confirmed the mint yet. Refresh in a minute and check your ${dtr.ticker} balance before minting again.`);return;}
   const report=e instanceof MultiAssetBuyError?e.report:null;
   if(report&&!report.reserveTokenMinted&&report.legs.some(l=>l.mint!==MAINNET_USDC_MINT&&BigInt(l.purchaseAcquiredRaw)>0n)){setRecover(true);setMessage(`Some USDC was swapped into the reserve assets, but no ${dtr.ticker} was minted. Convert those assets back to USDC, or mint again.`);return;}
   setMessage(e instanceof Error?e.message:'The mint did not complete.');
  }finally{setBusy(false);}
 };
 return <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
  <div className="flex items-start gap-2"><Coins className="w-4 h-4 mt-0.5 text-primary shrink-0"/>
   <div className="space-y-1 text-sm">
    <p className="font-medium">Mint {amount} more {dtr.ticker} first</p>
    <p className="text-muted-foreground">The treasury holds {Number(fromRaw(state.reserveBalanceRaw,state.reserveDecimals)).toLocaleString(undefined,{maximumFractionDigits:4})} {dtr.ticker}, which is not enough for this amount. Minting creates the missing tokens at the Reserve's backing value: about {formatUsdc(plan.mintUsdc)} of USDC is swapped into the reserve assets (mint fee included) and deposited in the Reserve. In total this needs about {formatUsdc(plan.totalUsdc)} of USDC.</p>
   </div></div>
  {!isTreasury&&<p className="text-sm text-destructive">Minted tokens go to the connected wallet. Connect the creator treasury wallet ({state.treasury.slice(0,4)}…{state.treasury.slice(-4)}) to mint them here.</p>}
  {plan.usdcShort&&<p className="text-sm text-destructive">The treasury does not hold enough USDC for the mint and the pool's USDC side together.</p>}
  <Button onClick={()=>void mint()} disabled={disabled||busy||!isTreasury||plan.usdcShort}><Coins className="w-3.5 h-3.5 mr-1.5"/>{busy?'Minting…':`Mint ${amount} ${dtr.ticker}`}</Button>
  {message&&<p role="status" className="text-sm whitespace-pre-wrap">{message}</p>}
  {recover&&<a href="/recover" className="text-sm underline">Convert reserve assets back to USDC</a>}
 </div>;
}
