import "./util/aliases"; // must precede any import that resolves "@/..." at runtime
import "./util/stubToasts";
import {expect} from 'chai';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Keypair,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {ConnectionProvider,WalletProvider} from '@solana/wallet-adapter-react';
import {readFileSync} from 'node:fs';
import {LiquidityTransactionReview} from '../src/merge/components/LiquidityTransactionReview';
import {walletErrorText} from '../src/merge/lib/liquidity/liquidityExecution';

describe('Liquidity review shows one step at a time',()=>{
 const a=Keypair.generate(),blockhash=Keypair.generate().publicKey.toBase58();
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:a.publicKey,recentBlockhash:blockhash,instructions:[SystemProgram.transfer({fromPubkey:a.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1})]}).compileToV0Message());
 const plan:any={action:'add',reserve:Keypair.generate().publicKey.toBase58(),pool:'',creator:a.publicKey.toBase58(),treasury:a.publicKey.toBase58(),transactionBase64:Buffer.from(tx.serialize()).toString('base64'),messageHash:'x',requiredSigners:[a.publicKey.toBase58()],blockhash,lastValidBlockHeight:100,expiresAtMs:Date.now()+45000,executionEnabled:true,confirmationText:'ADD',networkFeeRaw:'0',accountRentRaw:'0',totalSolRaw:'0',simulation:{slot:1,unitsConsumed:1,passed:true}};
 const render=(p:any)=>renderToStaticMarkup(React.createElement(ConnectionProvider,{endpoint:'http://127.0.0.1:8899'},React.createElement(WalletProvider,{wallets:[]},React.createElement(LiquidityTransactionReview,{plan:p,onRetry:()=>{}}))));
 it('offers exactly one approve action before signing, and no send or status buttons',()=>{
  const html=render(plan);
  expect(html.match(/<button/g)?.length).eq(1);
  expect(html).contain('Approve with connected wallet').contain('Type ADD to approve').contain('more seconds');
  expect(html).not.contain('Submit approved transaction').not.contain('Check saved transaction').not.contain('Send approved transaction');
 });
 it('replaces the approve action with Prepare again once the review has expired',()=>{
  const html=render({...plan,expiresAtMs:Date.now()-1});
  expect(html).contain('Prepare again').contain('has expired');expect(html).not.contain('Approve with connected wallet');
 });
});
describe('Liquidity outcomes pop up like Mint and Redeem',()=>{
 it('uses the shared confirmation toast for success and destructive toasts for errors',()=>{
  const review=readFileSync('src/merge/components/LiquidityTransactionReview.tsx','utf8'),mint=readFileSync('src/merge/components/LiquidityMintStep.tsx','utf8'),section=readFileSync('src/merge/components/LiveLiquiditySection.tsx','utf8');
  expect(review).contain("toast(transactionConfirmedToast(sig,").contain("variant:'destructive'").contain('still confirming').contain('not completed');
  expect(mint).contain("transactionConfirmedToast(signature,'Mint confirmed')").contain("title:'Mint did not finish'").contain("title:'Mint not completed'");
  expect(section).contain('could not be prepared').contain('One-time setup needed');
 });
 it('says plainly when the wallet approval was declined',()=>{
  expect(walletErrorText(new Error('User rejected the request.'))).eq('You declined the approval in your wallet, so nothing was sent.');
  expect(walletErrorText(new Error('Liquidity review expired'))).eq('Liquidity review expired');expect(walletErrorText(undefined)).eq('Could not complete this step.');
 });
});
