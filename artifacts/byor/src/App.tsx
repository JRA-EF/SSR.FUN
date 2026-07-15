import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import { Navbar } from '@/components/layout/Navbar';
import { Home } from '@/pages/Home';
import { Portfolio } from '@/pages/Portfolio';
import { DTRDetail } from '@/pages/DTRDetail';
import { CreateDTR } from '@/pages/CreateDTR';
import { ManageDTR } from '@/pages/ManageDTR';
import { Earn } from '@/pages/Earn';
import { HowItWorks } from '@/pages/HowItWorks';

const queryClient = new QueryClient();

function Router() {
  return (
    <div className="min-h-[100dvh] flex flex-col text-foreground selection:bg-primary/30">
      <Navbar />
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/portfolio" component={Portfolio} />
        <Route path="/create" component={CreateDTR} />
        <Route path="/earn" component={Earn} />
        <Route path="/how-it-works" component={HowItWorks} />
        <Route path="/dtr/:dtrId" component={DTRDetail} />
        <Route path="/dtr/:dtrId/manage" component={ManageDTR} />
        <Route component={NotFound} />
      </Switch>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
