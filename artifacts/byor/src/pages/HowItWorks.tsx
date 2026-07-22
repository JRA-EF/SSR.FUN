import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export function HowItWorks() {
  return (
    <div className="container mx-auto px-4 md:px-8 py-16 max-w-4xl">
      <div className="mb-16 text-center">
        <h1 className="text-4xl md:text-5xl font-display font-bold mb-6">How SSR.FUN Works</h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          The Reserve Asset Protocol allows anyone to deploy, manage, and trade fully collateralized token baskets on Solana.
        </p>
      </div>

      <div className="space-y-16">
        <section className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
          <div className="md:col-span-4">
            <div className="text-primary font-mono text-sm mb-2">Step 1</div>
            <h2 className="text-2xl font-display font-bold">Deploy a Reserve</h2>
          </div>
          <div className="md:col-span-8 space-y-4">
            <p className="text-muted-foreground leading-relaxed text-lg">
              Creators define a basket of Solana-native assets. You set the initial weights, select the target tokens, and configure protocol fees (Mint, TVL). Upon deployment, the protocol initializes an empty vault mapped to a unique Reserve token.
            </p>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
          <div className="md:col-span-4">
            <div className="text-primary font-mono text-sm mb-2">Step 2</div>
            <h2 className="text-2xl font-display font-bold">Minting & Backing</h2>
          </div>
          <div className="md:col-span-8 space-y-4">
            <p className="text-muted-foreground leading-relaxed text-lg">
              Users deposit USDC into the Reserve. The protocol automatically routes the liquidity to underlying DEXs (like Jupiter), purchasing the target assets according to the Manager's defined weights. The assets are locked securely in the vault, and newly minted Reserve tokens are issued to the user. Every token is 100% backed by verifiable on-chain assets.
            </p>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
          <div className="md:col-span-4">
            <div className="text-primary font-mono text-sm mb-2">Step 3</div>
            <h2 className="text-2xl font-display font-bold">Active Management</h2>
          </div>
          <div className="md:col-span-8 space-y-4">
            <p className="text-muted-foreground leading-relaxed text-lg">
              The Root Manager can assign delegates with granular permissions (e.g., Rebalancing, Fee Admin). As market conditions change, authorized delegates can trigger rebalances to adjust asset weights, maintaining the strategic mandate of the Reserve without requiring users to actively manage their own positions.
            </p>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
          <div className="md:col-span-4">
            <div className="text-primary font-mono text-sm mb-2">Step 4</div>
            <h2 className="text-2xl font-display font-bold">Trading & Redemption</h2>
          </div>
          <div className="md:col-span-8 space-y-4">
            <p className="text-muted-foreground leading-relaxed text-lg">
              Reserve tokens can be traded on secondary markets, or redeemed directly through the protocol. When redeemed, the smart contract liquidates the proportional slice of underlying vault assets back to USDC and burns the Reserve tokens, enforcing a hard floor on the token's price via arbitrage.
            </p>
            <div className="pt-6">
              <Button asChild size="lg">
                <Link href="/create">Deploy Your First Reserve</Link>
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}