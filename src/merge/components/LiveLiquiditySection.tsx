import {useEffect,useRef,useState} from 'react';
import {useConnection,useWallet} from '@solana/wallet-adapter-react';
import {PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,unpackMint,TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {cpmmLpMint,type CompoundApproval,type CompoundQuote} from '@ssr/sdk';
import type {DTR} from '../lib/types';
import type {PreparedLiquidity} from '../../../lib/mainnet/prepareCompound';
import {fetchLiveCompoundBundle,type LiveCompoundBundle} from '../lib/liquidity/compoundQuoteClient';
import {prepareSelectedCompound} from '../lib/liquidity/compoundPreparationClient';
import {LIQUIDITY_USDC,RAYDIUM_CPMM,SSR_CPMM_CONFIG} from '../lib/liquidity/raydiumCpmm';
import {CompoundRouteReview} from './CompoundRouteReview';
import {Card,CardContent,CardHeader,CardTitle} from './ui/card';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Label} from './ui/label';

/** Real account/quote review, separate from the design-preview store. */
export function LiveLiquiditySection({dtr}:{dtr:DTR}) {
  const {connection}=useConnection(),{publicKey}=useWallet();
  const [budget,setBudget]=useState(''),[bundle,setBundle]=useState<LiveCompoundBundle|null>(null);
  const [prepared,setPrepared]=useState<PreparedLiquidity|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [decimals,setDecimals]=useState<{reserve:number;lp:number}|null>(null);
  const generation=useRef(0),abort=useRef<AbortController|null>(null);
  const chain=dtr.onChain!,creator=publicKey?.toBase58()??null,treasury=chain.feeDestination;
  useEffect(()=>{
    const cancel=()=>{generation.current++;abort.current?.abort();};
    cancel();setBundle(null);setPrepared(null);setError(null);setBusy(false);
    return cancel;
  },[chain.reserve,creator,treasury,budget]);
  const refresh=async()=>{
    const current=++generation.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;
    setBusy(true);setError(null);setBundle(null);setPrepared(null);
    try{
      if(!treasury||creator!==chain.manager)throw new Error('Connect the creator wallet to compare routes.');
      if(!/^\d+(\.\d{1,6})?$/.test(budget))throw new Error('Enter a positive USDC amount with up to six decimal places.');
      const [whole,fraction='']=budget.split('.'),raw=BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'));
      if(raw<=0n||raw>0xffffffffffffffffn)throw new Error('Enter a valid earnings amount.');
      const mint=new PublicKey(chain.reserveTokenMint),[m0,m1]=[mint,LIQUIDITY_USDC].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
      const pool=PublicKey.findProgramAddressSync([Buffer.from('pool'),SSR_CPMM_CONFIG.toBuffer(),m0.toBuffer(),m1.toBuffer()],RAYDIUM_CPMM)[0],lp=cpmmLpMint(pool);
      const [mintAccount,lpAccount]=await connection.getMultipleAccountsInfo([mint,lp],'confirmed');
      if(!mintAccount?.owner.equals(TOKEN_2022_PROGRAM_ID)||!lpAccount)throw new Error('A supported liquidity pool is not available for this Reserve yet.');
      const rt=unpackMint(mint,mintAccount,TOKEN_2022_PROGRAM_ID),lpt=unpackMint(lp,lpAccount,TOKEN_PROGRAM_ID);
      const result=await fetchLiveCompoundBundle({reserve:chain.reserve,pool:pool.toBase58(),creator,lpDestination:getAssociatedTokenAddressSync(lp,new PublicKey(treasury),true).toBase58(),budgetUsdcRaw:raw,slippageBps:50,lockPolicyId:'unlocked'},controller.signal);
      if(current!==generation.current)return;
      setDecimals({reserve:rt.decimals,lp:lpt.decimals});setBundle(result);
    }catch(e){if(current===generation.current)setError(e instanceof Error?e.message:'Live quotes are unavailable.');}
    finally{if(current===generation.current)setBusy(false);}
  };
  const prepare=async(approval:CompoundApproval,quote:CompoundQuote)=>{
    if(!bundle||!treasury||busy)return;
    const current=++generation.current;setBusy(true);setError(null);setPrepared(null);
    try{
      const result=await prepareSelectedCompound(quote,approval,bundle.acquisitionPlans[quote.planFingerprint],treasury,abort.current?.signal);
      if(current===generation.current)setPrepared(result);
    }catch(e){if(current===generation.current)setError(e instanceof Error?e.message:'Could not prepare this route.');}
    finally{if(current===generation.current)setBusy(false);}
  };
  return <div className="space-y-6">
    <Card><CardHeader><CardTitle>Creator liquidity</CardTitle></CardHeader><CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">DEX liquidity is optional and separate from your Reserve backing. Compare how your settled creator earnings could increase liquidity.</p>
      <Label htmlFor="compound-budget">Settled earnings to compound (USDC)</Label>
      <Input id="compound-budget" inputMode="decimal" value={budget} onChange={e=>setBudget(e.target.value)} placeholder="0.00" disabled={busy}/>
      <p className="text-xs text-muted-foreground">Quotes allow 0.5% slippage. Earnings must already be in your fixed creator treasury. This review adds unlocked liquidity.</p>
      <Button onClick={()=>void refresh()} disabled={busy||!budget||creator!==chain.manager}>{busy?'Checking route…':'Compare live routes'}</Button>
      <p className="text-xs text-muted-foreground">Spending is unavailable while final release checks are pending. Reviewing a route does not request a wallet signature.</p>
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    </CardContent></Card>
    {bundle&&decimals&&<CompoundRouteReview comparison={bundle.comparison} connectedCreator={creator} reserveSymbol={dtr.ticker} reserveDecimals={decimals.reserve} lpDecimals={decimals.lp} onApprove={(a,q)=>void prepare(a,q)} onRefresh={()=>void refresh()} refreshing={busy}/>}
    {prepared&&<Card><CardHeader><CardTitle>Compound simulation passed</CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="text-sm">The selected acquisition and liquidity addition fit one transaction. Both must succeed together.</p>
      <p className="text-sm font-merge-mono">Estimated total SOL cost: {(Number(prepared.totalSolRaw)/1e9).toFixed(9)} SOL</p>
      <p className="text-xs text-muted-foreground">Measured from simulation, including network fees and account setup. Final execution will require creator and treasury authorization and a current quote. No funds have moved.</p>
    </CardContent></Card>}
  </div>;
}
