#!/usr/bin/env bash
# Deploy SSR's EVM stack to a chain and register it -- the last on-chain step
# of .claude/skills/evm-chain-onboarding. Prints the ChainConfig addresses to
# paste; it does NOT flip `live` or ship the frontend (those stay reviewed).
#
#   scripts/go-live-evm-chain.sh bnb --rehearse   # same steps, real keys, on a fork
#   scripts/go-live-evm-chain.sh bnb              # mainnet. Spends real gas.
#
# Keys are read from ~/.config/evm/ssr-evm-{deploy,owner}.json and never
# printed. The deployer only pays gas; the owner holds admin and sends
# registerVersion -- the same separation Robinhood mainnet uses.
set -euo pipefail

CHAIN="${1:?usage: go-live-evm-chain.sh <chain> [--rehearse]}"
MODE="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(dirname "$HERE")"
EVM="${SSR_EVM_DIR:-$(dirname "$APP")/ssr-evm}"
CFG="$HERE/evm-chains/$CHAIN.json"
[ -f "$CFG" ] || { echo "no $CFG"; exit 1; }

field() { python3 -c "import json;print(json.load(open('$CFG'))['$1'])"; }
key()   { python3 -c "import json;print(json.load(open('$HOME/.config/evm/ssr-evm-$1.json'))[0]['$2'])"; }
WANT_ID="$(field chainId)"
RPC="${RPC_URL:-$(field rpc)}"
DEPLOYER_ADDR="$(key deploy address)"
OWNER_ADDR="$(key owner address)"

if [ "$MODE" = "--rehearse" ]; then
  echo "REHEARSAL: forking $CHAIN; nothing touches the real chain"
  PORT=8599
  pkill -f "anvil.*--port $PORT" 2>/dev/null || true
  anvil --fork-url "$RPC" --port $PORT --silent --no-storage-caching >/tmp/go-live-anvil.log 2>&1 &
  ANVIL=$!
  trap 'kill $ANVIL 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do cast chain-id --rpc-url http://127.0.0.1:$PORT >/dev/null 2>&1 && break; sleep 1; done
  RPC="http://127.0.0.1:$PORT"
  # Fund the real addresses ON THE FORK only, as a real deploy would need.
  for a in "$DEPLOYER_ADDR" "$OWNER_ADDR"; do cast rpc anvil_setBalance "$a" 0x16345785D8A0000 --rpc-url "$RPC" >/dev/null; done
elif [ -n "$MODE" ]; then
  echo "unknown mode $MODE"; exit 1
fi

GOT_ID="$(cast chain-id --rpc-url "$RPC")"
[ "$GOT_ID" = "$WANT_ID" ] || { echo "RPC is chain $GOT_ID, expected $WANT_ID -- refusing"; exit 1; }

echo "chain $GOT_ID   deployer $DEPLOYER_ADDR   owner $OWNER_ADDR"
for pair in "deployer:$DEPLOYER_ADDR:0.003" "owner:$OWNER_ADDR:0.0005"; do
  IFS=: read -r name addr need <<<"$pair"
  bal="$(cast balance "$addr" --rpc-url "$RPC" --ether)"
  python3 -c "import sys; sys.exit(0 if float('$bal') >= $need else 1)" \
    || { echo "  $name holds $bal native; needs >= $need for gas. Fund $addr and re-run."; exit 1; }
  echo "  $name balance $bal"
done

echo "1/3 deploying the five contracts"
cd "$EVM"
SSR_OWNER="$OWNER_ADDR" ETHERSCAN_KEY="${ETHERSCAN_KEY:-x}" \
  forge script script/SSRMainnet.s.sol --rpc-url "$RPC" --broadcast \
  --private-key "$(key deploy private_key)" >/tmp/go-live-forge.log 2>&1 \
  || { sed 's/\x1b\[[0-9;]*m//g' /tmp/go-live-forge.log | grep -av 'DOCTYPE\|mintlify\|deserialize' | tail -15; exit 1; }
LOG="$(sed 's/\x1b\[[0-9;]*m//g' /tmp/go-live-forge.log)"
get() { echo "$LOG" | grep -aE "^  $1 " | awk '{print $2}'; }
ROLE="$(get roleRegistry)"; FEE="$(get feeRegistry)"; VER="$(get versionRegistry)"; FILL="$(get fillerRegistry)"; DEP="$(get deployer)"
[ -n "$DEP" ] || { echo "could not read the deployer address from forge's output"; exit 1; }
BLOCK="$(python3 -c "
import json
r=json.load(open('broadcast/SSRMainnet.s.sol/$GOT_ID/run-latest.json'))
print(min(int(x['blockNumber'],16) for x in r['receipts'] if (x.get('contractAddress') or '').lower()=='${DEP}'.lower()))
")"

echo "2/3 registerVersion (from the owner)"
cast send "$VER" "registerVersion(address)" "$DEP" --rpc-url "$RPC" --private-key "$(key owner private_key)" >/dev/null

echo "3/3 verifying"
V="$(cast call "$VER" 'getLatestVersion()(bytes32,string,address,bool)' --rpc-url "$RPC")"
echo "$V" | grep -qi "$DEP" || { echo "getLatestVersion does not point at the new deployer:"; echo "$V"; exit 1; }
ADMIN="$(cast call "$ROLE" 'getRoleMember(bytes32,uint256)(address)' 0x0000000000000000000000000000000000000000000000000000000000000000 0 --rpc-url "$RPC")"
[ "$(echo "$ADMIN" | tr A-F a-f)" = "$(echo "$OWNER_ADDR" | tr A-F a-f)" ] || { echo "admin is $ADMIN, expected the owner"; exit 1; }
echo "  version $(echo "$V" | sed -n 2p)  admin = owner  deployed at block $BLOCK"

cat <<EOF

Paste into CHAINS.$CHAIN in src/merge/lib/evmChain.ts:

    deployer: "$DEP",
    deployerBlock: ${BLOCK}n,
    versionRegistry: "$VER",
    feeRegistry: "$FEE",
    roleRegistry: "$ROLE",
    fillerRegistry: "$FILL",

Then: set live: true there, add $CHAIN to EVM_LAUNCH_OPTIONS in
src/merge/lib/chainChoice.ts (the registry test keeps them in step), and run
scripts/verify_evm_launch_fork.mts before shipping the frontend.
EOF
[ "$MODE" = "--rehearse" ] && echo "(REHEARSAL -- these addresses exist only on the fork)"
