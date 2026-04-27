#!/usr/bin/env ts-node
// scripts/prelaunch.ts — CLI для управления pre-launch watchlist
//
// Использование:
//   npx ts-node scripts/prelaunch.ts list
//   npx ts-node scripts/prelaunch.ts add --ticker PEPE --creator <addr> --source telegram --notes "анонс в альфа-чате"
//   npx ts-node scripts/prelaunch.ts add --ticker MOON --mint <addr> --source twitter
//   npx ts-node scripts/prelaunch.ts remove <id>
//   npx ts-node scripts/prelaunch.ts clear

import { PreLaunchWatcher } from '../src/core/prelaunch-watcher';

const watcher = new PreLaunchWatcher();
const [, , cmd, ...rest] = process.argv;

function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1]) {
      out[args[i].slice(2)] = args[++i];
    }
  }
  return out;
}

switch (cmd) {
  case 'list': {
    const all = watcher.list();
    if (!all.length) { console.log('Pre-launch watchlist is empty.'); break; }
    console.log(`\nPre-launch watchlist (${watcher.activeCount} active / ${all.length} total):\n`);
    for (const c of all) {
      const status = c.fired ? `✅ FIRED ${c.firedMint?.slice(0, 8)}` : Date.now() > c.expiresAt ? '⏰ EXPIRED' : '⏳ WAITING';
      const expires = new Date(c.expiresAt).toLocaleString();
      console.log(
        `  [${status}] ${c.ticker ?? '(no ticker)'}` +
        `\n    id:      ${c.id}` +
        `\n    mint:    ${c.mint ?? '-'}` +
        `\n    creator: ${c.creator ?? '-'}` +
        `\n    source:  ${c.source}${c.notes ? `  notes: ${c.notes}` : ''}` +
        `\n    expires: ${expires}\n`
      );
    }
    break;
  }

  case 'add': {
    const args = parseArgs(rest);
    if (!args.source) { console.error('Error: --source is required (e.g. telegram, twitter, manual)'); process.exit(1); }
    if (!args.mint && !args.creator) { console.error('Error: --mint or --creator (or both) required'); process.exit(1); }
    const id = watcher.add({
      ticker:  args.ticker,
      mint:    args.mint,
      creator: args.creator,
      source:  args.source,
      notes:   args.notes,
    });
    console.log(`✅ Added pre-launch candidate: ${args.ticker ?? id}`);
    console.log(`   id: ${id}`);
    console.log(`   Will expire in 24 hours.`);
    break;
  }

  case 'remove': {
    const id = rest[0];
    if (!id) { console.error('Error: provide id to remove'); process.exit(1); }
    const ok = watcher.remove(id);
    console.log(ok ? `✅ Removed ${id}` : `❌ Not found: ${id}`);
    break;
  }

  case 'clear': {
    const count = watcher.clear(true);
    console.log(`✅ Cleared ${count} candidates`);
    break;
  }

  default:
    console.log(`
Pre-launch watchlist CLI

Commands:
  list                                        — show all candidates
  add --ticker <TICK> --mint <addr>           — add by known mint (first-block match)
      --creator <addr> --source <src>
      --notes "text"
  remove <id>                                 — remove by id
  clear                                       — clear all

Sources: telegram | twitter | manual | alpha

Examples:
  npx ts-node scripts/prelaunch.ts add --ticker PEPE --creator AaBbCc... --source telegram
  npx ts-node scripts/prelaunch.ts add --mint XxYyZz... --source alpha --notes "инсайд из чата"
`);
}
