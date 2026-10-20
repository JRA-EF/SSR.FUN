import "./util/aliases"; // must precede any import that resolves "@/..." at runtime
import {expect} from 'chai';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Keypair,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {ConnectionProvider,WalletProvider} from '@solana/wallet-adapter-react';
import {LiquidityTransactionReview} from '../src/merge/components/LiquidityTransactionReview';

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
