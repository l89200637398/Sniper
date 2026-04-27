import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../store';

export function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const nav = useNavigate();
  const setAuthFailed = useStore(s => s.setAuthFailed);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.login(password);
      setAuthFailed(false);
      nav('/dashboard');
    } catch {
      setError('Invalid password');
    }
  };

  return (
    <div className="flex items-center justify-center h-screen bg-zinc-950">
      <form onSubmit={submit} className="bg-zinc-900 p-8 rounded-2xl space-y-4 w-80">
        <h1 className="text-xl font-bold text-center text-white">Sniper Bot</h1>
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        {error && <div className="text-red-400 text-xs">{error}</div>}
        <button
          type="submit"
          className="w-full bg-green-600 hover:bg-green-500 rounded-lg py-2 text-sm font-medium text-white"
        >
          Login
        </button>
      </form>
    </div>
  );
}
