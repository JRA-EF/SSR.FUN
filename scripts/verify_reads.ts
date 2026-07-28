import { Connection, PublicKey } from "@solana/web3.js";
import { fetchReserveOnChain, DEVNET_FIXTURES } from "../packages/sdk/src";

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const programId = new PublicKey(DEVNET_FIXTURES.programId);

  for (const key of ["reserveOne", "reserveTwo"] as const) {
    const fixture = DEVNET_FIXTURES[key];
    const reserveAddress = new PublicKey(fixture.reserve);
    const mints = fixture.assets.map((a) => new PublicKey(a.mint));
    const onChain = await fetchReserveOnChain(connection, programId, reserveAddress, mints);
    console.log(`\n=== ${key} (${fixture.reserve}) ===`);
    console.log(JSON.stringify(onChain, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
