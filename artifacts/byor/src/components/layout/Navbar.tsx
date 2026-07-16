import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Search, Wallet, ChevronDown, LogOut, RefreshCw, PlusCircle, LayoutDashboard, Wallet as WalletIcon, Ghost, Flame, Backpack, User, Sun, Moon } from "lucide-react";
import ssrLogo from "@/assets/ssr-logo.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAppStore } from "@/store/useAppStore";
import { formatUsdc } from "@/lib/calculations";
import { SiSolana } from "react-icons/si";
import { useTheme } from "@/hooks/use-theme";

export function Navbar() {
  const [, setLocation] = useLocation();
  const { wallet, dtrs, connectWallet, disconnectWallet, addDemoUSDC, resetSimulation } = useAppStore();
  const { theme, toggleTheme } = useTheme();
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);

  const q = searchQuery.trim().toLowerCase();
  const searchResults = (q
    ? dtrs.filter((d) => d.name.toLowerCase().includes(q) || d.ticker.toLowerCase().includes(q))
    : dtrs
  ).slice(0, 5);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setIsSearchOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleWalletConnect = async (provider: "phantom" | "solflare" | "backpack") => {
    await connectWallet(provider);
    setIsWalletModalOpen(false);
  };

  const handleSearchSelect = (dtrId: string) => {
    setLocation(`/dtr/${dtrId}`);
    setIsSearchOpen(false);
    setSearchQuery("");
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-16 items-center justify-between gap-3 px-4 md:px-6">
        <div className="flex items-center gap-3 lg:gap-4 min-w-0">
          <Link href="/" className="inline-flex items-center gap-2 shrink-0">
            <img src={ssrLogo} alt="SSR.FUN" className="block h-8 w-8 rounded-full object-cover" style={{verticalAlign: 'middle'}} />
            <span className="font-display font-bold text-xl tracking-tighter text-foreground" style={{lineHeight: '2rem', display: 'inline-block', verticalAlign: 'middle'}}>
              SSR<span className="text-primary">.FUN</span>
            </span>
          </Link>

          <Badge variant="outline" className="hidden xl:inline-flex bg-primary/5 text-primary border-primary/20 shrink-0" title="Fictional balances, prices and transactions. No real assets are being used.">
            Simulation Mode
          </Badge>

          <nav className="hidden lg:flex items-center gap-4 text-sm font-medium text-muted-foreground whitespace-nowrap">
            <a href="/#directory" className="hover:text-primary transition-colors cursor-pointer">Discover DTRs</a>
            <Link href="/create" className="hover:text-primary transition-colors">Create a DTR</Link>
            <Link href="/portfolio" className="hover:text-primary transition-colors">Portfolio</Link>
            <Link href="/earn" className="hover:text-primary transition-colors">Earn</Link>
            <Link href="/how-it-works" className="hover:text-primary transition-colors">How It Works</Link>
          </nav>
        </div>

        <div className="flex items-center gap-3 justify-end shrink-0">
          <div className="relative w-44 lg:w-56 xl:w-72 hidden md:block" ref={searchRef}>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search DTRs..."
                className="w-full bg-muted/50 pl-9 border-border focus-visible:ring-primary h-9"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setIsSearchOpen(true);
                }}
                onFocus={() => setIsSearchOpen(true)}
              />
            </div>
            {isSearchOpen && searchQuery && (
              <div className="absolute top-full mt-1 w-full rounded-md border border-border bg-popover shadow-md overflow-hidden z-50">
                {searchResults.length > 0 ? (
                  <div className="py-1">
                    {searchResults.map((dtr) => (
                      <button
                        key={dtr.id}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-muted focus:bg-muted outline-none flex items-center justify-between group"
                        onClick={() => handleSearchSelect(dtr.id)}
                      >
                        <div>
                          <span className="font-medium text-foreground">{dtr.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{dtr.ticker}</span>
                        </div>
                        <span className="text-primary opacity-0 group-hover:opacity-100 transition-opacity">View →</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 text-sm text-center text-muted-foreground">
                    No reserves found.
                  </div>
                )}
              </div>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground shrink-0"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>

          {wallet.connected ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-2 bg-muted/50 border-border hover:bg-muted hover:text-foreground">
                  <div className="w-4 h-4 rounded-full bg-gradient-to-tr from-primary to-blue-500" />
                  <span className="hidden sm:inline-block">
                    {wallet.address?.slice(0, 4)}...{wallet.address?.slice(-4)}
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>
                  <div className="flex flex-col space-y-1">
                    <p className="text-sm font-medium leading-none">Wallet Connected</p>
                    <p className="text-xs leading-none text-muted-foreground">
                      {wallet.address?.slice(0, 8)}...{wallet.address?.slice(-8)}
                    </p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <div className="p-2 space-y-2">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-muted-foreground flex items-center gap-1.5"><WalletIcon className="h-3.5 w-3.5" /> USDC</span>
                    <span className="font-mono">{formatUsdc(wallet.usdc)}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-muted-foreground flex items-center gap-1.5"><SiSolana className="h-3.5 w-3.5" /> SOL</span>
                    <span className="font-mono">{wallet.sol.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-muted-foreground flex items-center gap-1.5"><div className="w-3.5 h-3.5 rounded-full bg-primary/20 border border-primary flex items-center justify-center text-[8px] font-bold text-primary">S</div> SSR</span>
                    <span className="font-mono">{wallet.ssr.toLocaleString()}</span>
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/portfolio" className="cursor-pointer flex w-full items-center">
                    <LayoutDashboard className="mr-2 h-4 w-4" /> Portfolio
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/profile/${wallet.address}`} className="cursor-pointer flex w-full items-center">
                    <User className="mr-2 h-4 w-4" /> My Profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={addDemoUSDC} className="cursor-pointer">
                  <PlusCircle className="mr-2 h-4 w-4 text-primary" /> Add 10,000 Demo USDC
                </DropdownMenuItem>
                <DropdownMenuItem onClick={resetSimulation} className="cursor-pointer">
                  <RefreshCw className="mr-2 h-4 w-4" /> Reset Simulation
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={disconnectWallet} className="cursor-pointer text-destructive focus:bg-destructive/10 focus:text-destructive">
                  <LogOut className="mr-2 h-4 w-4" /> Disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Dialog open={isWalletModalOpen} onOpenChange={setIsWalletModalOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2">
                  <Wallet className="h-4 w-4" />
                  <span className="hidden sm:inline-block">Connect Wallet</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md border-border bg-card">
                <DialogHeader>
                  <DialogTitle className="font-display text-xl">Connect Wallet</DialogTitle>
                  <DialogDescription>
                    Select a wallet to connect to the SSR.FUN Simulation. No real transactions will occur.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 py-4">
                  {wallet.connecting ? (
                    <div className="flex flex-col items-center justify-center py-8 space-y-4">
                      <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                      <p className="text-sm text-muted-foreground animate-pulse">Connecting to wallet...</p>
                    </div>
                  ) : (
                    <>
                      <Button variant="outline" className="h-14 justify-start px-4 text-left border-border hover:bg-muted hover:border-primary/50 transition-colors" onClick={() => handleWalletConnect("phantom")}>
                        <div className="w-8 h-8 mr-3 rounded-full bg-[#AB9FF2] flex items-center justify-center shrink-0">
                          <Ghost className="w-5 h-5 text-white" strokeWidth={2.25} />
                        </div>
                        <div className="flex flex-col">
                          <span className="font-semibold">Phantom</span>
                          <span className="text-xs text-muted-foreground">Solana Wallet</span>
                        </div>
                      </Button>
                      <Button variant="outline" className="h-14 justify-start px-4 text-left border-border hover:bg-muted hover:border-primary/50 transition-colors" onClick={() => handleWalletConnect("solflare")}>
                        <div className="w-8 h-8 mr-3 rounded-full bg-[#FC7A1D] flex items-center justify-center shrink-0">
                          <Flame className="w-5 h-5 text-white" strokeWidth={2.25} />
                        </div>
                        <div className="flex flex-col">
                          <span className="font-semibold">Solflare</span>
                          <span className="text-xs text-muted-foreground">Solana Wallet</span>
                        </div>
                      </Button>
                      <Button variant="outline" className="h-14 justify-start px-4 text-left border-border hover:bg-muted hover:border-primary/50 transition-colors" onClick={() => handleWalletConnect("backpack")}>
                        <div className="w-8 h-8 mr-3 rounded-full bg-[#E33E3F] flex items-center justify-center shrink-0">
                          <Backpack className="w-5 h-5 text-white" strokeWidth={2.25} />
                        </div>
                        <div className="flex flex-col">
                          <span className="font-semibold">Backpack</span>
                          <span className="text-xs text-muted-foreground">Solana Wallet</span>
                        </div>
                      </Button>
                    </>
                  )}
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>
      
      {/* Mobile nav links */}
      <div className="lg:hidden border-t border-border/40 bg-muted/20 px-4 py-2 flex items-center gap-4 text-sm font-medium overflow-x-auto">
        <a href="/#directory" className="hover:text-primary transition-colors py-1 whitespace-nowrap">Discover DTRs</a>
        <Link href="/create" className="hover:text-primary transition-colors py-1 whitespace-nowrap">Create</Link>
        <Link href="/portfolio" className="hover:text-primary transition-colors py-1 whitespace-nowrap">Portfolio</Link>
        <Link href="/earn" className="hover:text-primary transition-colors py-1 whitespace-nowrap">Earn</Link>
        <Link href="/how-it-works" className="hover:text-primary transition-colors py-1 whitespace-nowrap">How It Works</Link>
      </div>
    </header>
  );
}
