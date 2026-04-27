import { memo, useState, useCallback } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useStore } from '../store';
import { LayoutDashboard, History, Settings, ShieldOff, Rss, Star, Users, Terminal, Menu, X, Wifi, WifiOff, FlaskConical } from 'lucide-react';

const nav = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/trades',     icon: History,        label: 'Trades' },
  { to: '/config',     icon: Settings,       label: 'Config' },
  { to: '/blacklist',  icon: ShieldOff,      label: 'Blacklist' },
  { to: '/social',     icon: Rss,            label: 'Social Feed' },
  { to: '/tokens',     icon: Star,           label: 'Token Quality' },
  { to: '/wallets',    icon: Users,          label: 'Copy-Trade' },
  { to: '/logs',       icon: Terminal,       label: 'Logs' },
  { to: '/shadow',     icon: FlaskConical,   label: 'Shadow' },
];

const SidebarContent = memo(function SidebarContent({ onNavClick }: { onNavClick?: () => void }) {
  const balanceSol = useStore(s => s.balanceSol);
  const geyser = useStore(s => s.status.geyser);
  const isRunning = useStore(s => s.status.isRunning);
  const wsConnected = useStore(s => s.wsConnected);
  const defensiveMode = useStore(s => s.status.defensiveMode);

  return (
    <>
      <div className="text-lg font-bold mb-4 text-green-400">Sniper</div>
      {nav.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavClick}
          className={({ isActive }) =>
            `flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition
             ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-900'}`
          }
        >
          <Icon size={16} />{label}
        </NavLink>
      ))}
      <div className="mt-auto text-xs text-zinc-500 space-y-1 pt-4">
        <div>Balance: <span className="text-green-400">{balanceSol.toFixed(3)} SOL</span></div>
        <div className="flex items-center gap-1">
          {wsConnected ? <Wifi size={12} className="text-green-500" /> : <WifiOff size={12} className="text-red-500" />}
          {wsConnected ? 'Connected' : 'Disconnected'}
        </div>
        <div className="flex items-center gap-1">
          <span className={`w-2 h-2 rounded-full ${geyser === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
          Geyser {geyser}
        </div>
        <div className="flex items-center gap-1">
          <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-500' : 'bg-zinc-600'}`} />
          {isRunning ? 'Running' : 'Stopped'}
          {defensiveMode && <span className="ml-1 text-yellow-400">(Defensive)</span>}
        </div>
      </div>
    </>
  );
});

function ConnectionBanner() {
  const wsConnected = useStore(s => s.wsConnected);
  if (wsConnected) return null;
  return (
    <div className="bg-red-900/60 text-red-200 text-xs text-center py-1.5 px-4 flex items-center justify-center gap-2">
      <WifiOff size={12} /> WebSocket disconnected — reconnecting...
    </div>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-56 flex-col border-r border-zinc-800 p-4 gap-1">
        <SidebarContent />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={closeMobile} />
          <aside className="relative z-50 w-64 h-full flex flex-col bg-zinc-950 border-r border-zinc-800 p-4 gap-1">
            <button onClick={closeMobile} className="absolute top-4 right-4 text-zinc-400 hover:text-white">
              <X size={20} />
            </button>
            <SidebarContent onNavClick={closeMobile} />
          </aside>
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden">
        <ConnectionBanner />
        {/* Mobile header */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
          <button onClick={() => setMobileOpen(true)} className="text-zinc-400 hover:text-white">
            <Menu size={22} />
          </button>
          <span className="text-green-400 font-bold">Sniper</span>
        </div>

        <main className="flex-1 overflow-auto p-4 md:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
