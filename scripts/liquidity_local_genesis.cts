/** Synthetic LOCAL-only genesis accounts for testing real Raydium binaries.
 * None of these fabricated permissions or balances exist on Mainnet. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {Keypair,PublicKey,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,MintLayout,AccountLayout,NATIVE_MINT} from '@solana/spl-token';
const root='/tmp/ssr-liquidity-fixtures';mkdirSync(root,{recursive:true});
const payer=Keypair.generate();writeFileSync('/tmp/ssr-liquidity-payer.json',JSON.stringify([...payer.secretKey]),{mode:0o600});
const ray=new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
function account(address:PublicKey,owner:PublicKey,data:Buffer,lamports=1000000000){writeFileSync(`${root}/${address}.json`,JSON.stringify({pubkey:address.toBase58(),account:{lamports,owner:owner.toBase58(),executable:false,rentEpoch:0,data:[data.toString('base64'),'base64']}}));}
const permission=PublicKey.findProgramAddressSync([Buffer.from('permission'),payer.publicKey.toBuffer()],ray)[0],p=Buffer.alloc(280);Buffer.from([224,83,28,79,10,253,161,28]).copy(p);payer.publicKey.toBuffer().copy(p,8);account(permission,ray,p);
const approved=new PublicKey('6smLxV5X1n7wYPGN4F6EsFNHTPizmUNQkdBBHMCFoqAS'),approvedPermission=PublicKey.findProgramAddressSync([Buffer.from('permission'),approved.toBuffer()],ray)[0],approvedData=Buffer.from(p);approved.toBuffer().copy(approvedData,8);account(approvedPermission,ray,approvedData);
const config=new PublicKey('LNmHRmMvk9kmtepfTSr98kqGLThd61kH1DPWf2cVRaC'),c=Buffer.alloc(236);Buffer.from([218,244,33,104,203,203,43,111]).copy(c);c.writeUInt16LE(9,10);c.writeBigUInt64LE(2500n,12);c.writeBigUInt64LE(120000n,20);c.writeBigUInt64LE(40000n,28);c.writeBigUInt64LE(7500n,108);c.writeBigUInt64LE(50000n,116);account(config,ray,c);
const mint=Buffer.alloc(MintLayout.span);MintLayout.encode({mintAuthorityOption:1,mintAuthority:payer.publicKey,supply:0n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},mint);account(new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),TOKEN_PROGRAM_ID,mint);
const fee=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:NATIVE_MINT,owner:payer.publicKey,amount:0n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:1,isNative:2039280n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},fee);account(new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8'),TOKEN_PROGRAM_ID,fee,2039280);
console.log(JSON.stringify({localOnly:true,directory:root,payer:payer.publicKey.toBase58(),permission:permission.toBase58()}));
