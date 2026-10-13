/** Release is source-controlled. An environment variable cannot bypass missing
 * deployment, signer, real-pool and end-to-end evidence. */
import {LIQUIDITY_EXECUTION_ENABLED} from '../../lib/mainnet/liquidityRelease';
import type {ApiRequest,ApiResponse} from '../devnet/_lib/apiTypes';
export default function handler(req:ApiRequest,res:ApiResponse & {setHeader?(name:string,value:string):void}){
 res.setHeader?.('Cache-Control','no-store');
 if(req.method!=='GET'){res.status(405).json({error:'Method not allowed'});return;}
 res.status(200).json({executionEnabled:LIQUIDITY_EXECUTION_ENABLED,program:'8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9',reason:'Released with the DEC-0240 program upgrade.'});
}
