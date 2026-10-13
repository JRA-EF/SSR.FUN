import {expect} from 'chai';
import {Keypair} from '@solana/web3.js';
import {addAmounts,withdrawAmounts,canonicalLiquidityPool} from '../lib/mainnet/liquidityLifecycle';
import {integerSqrt} from '../lib/mainnet/atomicPool';
import {parseLifecycleRequest} from '../api/mainnet/liquidity';
const s={usdc:1000000n,tokens:2000000n,lpSupply:3000000n,fee:{epoch:0n,maximumFee:100000n,transferFeeBasisPoints:15}};
describe('Liquidity lifecycle limits',()=>{
 it('quotes balanced additions after transfer fees and protects both caps',()=>{const q=addAmounts(s,100000n,200000n,50);expect(q.lp).gt(0n);expect(q.usdc<=100000n&&q.reserve<=200000n).eq(true);expect(q.lp).eq(298052n);});
 it('protects net withdrawal output after the Reserve transfer fee',()=>{const q=withdrawAmounts(s,300000n,50);expect(q).deep.eq({usdc:100000n,reserve:199700n,minimumUsdc:99500n,minimumReserve:198701n});});
 it('rejects dust, overflow and unbounded slippage',()=>{expect(()=>addAmounts(s,0n,100n,50)).throws();expect(()=>addAmounts(s,1n,1n,50)).throws();expect(()=>addAmounts(s,1n<<64n,100n,50)).throws();expect(()=>withdrawAmounts(s,1n,50)).throws();expect(()=>withdrawAmounts(s,3000001n,50)).throws();expect(()=>addAmounts(s,100n,100n,101)).throws();});
 it('uses an integer square root at initial-liquidity and u64 boundaries',()=>{for(const x of [0n,1n,2n,3n,4n,100n,999999999999999999n,(1n<<128n)-1n]){const r=integerSqrt(x);expect(r*r<=x&&(r+1n)*(r+1n)>x).eq(true);}expect(()=>integerSqrt(-1n)).throws();});
 it('validates raw amounts without floating-point conversion',()=>{const body={action:'add',reserve:Keypair.generate().publicKey.toBase58(),actor:Keypair.generate().publicKey.toBase58(),maximumSolRaw:'50000000',maximumUsdcRaw:'1000000',maximumReserveRaw:'1000000',lock:'3-month',slippageBps:50};expect(parseLifecycleRequest(body).maximumUsdcRaw).eq(1000000n);for(const amount of [-1,'1.2','1e6','18446744073709551616'])expect(()=>parseLifecycleRequest({...body,maximumUsdcRaw:amount})).throws();expect(()=>parseLifecycleRequest({...body,maximumSolRaw:'0'})).throws();expect(()=>parseLifecycleRequest({...body,lock:'60%'})).throws();expect(()=>parseLifecycleRequest({...body,action:'send'})).throws();});
 it('deterministically derives one canonical config-9 pool per Reserve mint',()=>{const mint=Keypair.generate().publicKey;expect(canonicalLiquidityPool(mint).equals(canonicalLiquidityPool(mint))).eq(true);expect(canonicalLiquidityPool(mint).equals(canonicalLiquidityPool(Keypair.generate().publicKey))).eq(false);});
});
