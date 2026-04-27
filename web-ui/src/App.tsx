import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { bindSocketToStore } from './store';
import { useStore } from './store';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Trades } from './pages/Trades';
import { Config } from './pages/Config';
import { Blacklist } from './pages/Blacklist';
import { WalletTracker } from './pages/WalletTracker';
import { SocialFeed } from './pages/SocialFeed';

import { Logs } from './pages/Logs';
import { TokenQuality } from './pages/TokenQuality';
import { Shadow } from './pages/Shadow';

function AuthGuard({ children }: { children: React.ReactNode }) {
  const authFailed = useStore(s => s.authFailed);
  const location = useLocation();
  if (authFailed && !location.pathname.startsWith('/login')) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  useEffect(() => {
    bindSocketToStore();
  }, []);

  return (
    <BrowserRouter>
      <AuthGuard>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/trades" element={<Trades />} />
            <Route path="/config" element={<Config />} />
            <Route path="/blacklist" element={<Blacklist />} />
            <Route path="/social" element={<SocialFeed />} />
            <Route path="/tokens" element={<TokenQuality />} />
            <Route path="/wallets" element={<WalletTracker />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/shadow" element={<Shadow />} />
          </Route>
        </Routes>
      </AuthGuard>
    </BrowserRouter>
  );
}
