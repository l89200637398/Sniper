// scripts/blacklist.ts
//
// CLI для управления F7 blacklist'ом без рестарта снайпера.
// Пишет напрямую в data/blacklist.json (через blacklist-store).
// Боевой Sniper подхватит изменения через polling-reload (до 60с).
//
// Использование:
//   npm run blacklist add        <mint>
//   npm run blacklist remove     <mint>
//   npm run blacklist add-creator    <creator>
//   npm run blacklist remove-creator <creator>
//   npm run blacklist list
//   npm run blacklist stats
//   npm run blacklist clear           (внимание: чистит ВЕСЬ список)
//
// Без npm:
//   npx ts-node scripts/blacklist.ts <command> [args]

import {
  loadBlacklist,
  saveBlacklist,
  BLACKLIST_FILE,
} from '../src/core/blacklist-store';

const USAGE = `
Использование:
  blacklist add              <mint>
  blacklist remove           <mint>
  blacklist add-creator      <creator>
  blacklist remove-creator   <creator>
  blacklist list
  blacklist stats
  blacklist clear

Файл: ${BLACKLIST_FILE}
Sniper подхватит изменения в течение ~60 секунд (polling reload).
`.trim();

function exit(code: number, msg?: string): never {
  if (msg) console.log(msg);
  process.exit(code);
}

function isBase58Like(s: string): boolean {
  // Лёгкий sanity-check, не валидация Pubkey: 32-44 символа, без [0OIl].
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function main() {
  const [, , cmd, arg] = process.argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    exit(0, USAGE);
  }

  const bl = loadBlacklist();

  switch (cmd) {
    case 'add': {
      if (!arg) exit(2, 'Нужен <mint>. Пример: blacklist add EPjFW...');
      if (!isBase58Like(arg)) exit(2, `"${arg}" не похож на Solana mint (base58, 32-44 символа)`);
      if (bl.tokens.has(arg)) exit(0, `Уже в blacklist: ${arg}`);
      bl.tokens.add(arg);
      saveBlacklist(bl.tokens, bl.creators);
      exit(0, `🚫 Token blacklisted: ${arg}\n   tokens=${bl.tokens.size} creators=${bl.creators.size}`);
    }

    case 'remove': {
      if (!arg) exit(2, 'Нужен <mint>. Пример: blacklist remove EPjFW...');
      if (!bl.tokens.has(arg)) exit(0, `Не в blacklist: ${arg}`);
      bl.tokens.delete(arg);
      saveBlacklist(bl.tokens, bl.creators);
      exit(0, `✅ Token unblacklisted: ${arg}\n   tokens=${bl.tokens.size} creators=${bl.creators.size}`);
    }

    case 'add-creator': {
      if (!arg) exit(2, 'Нужен <creator>. Пример: blacklist add-creator 7xKXt...');
      if (!isBase58Like(arg)) exit(2, `"${arg}" не похож на Solana address`);
      if (bl.creators.has(arg)) exit(0, `Creator уже в blacklist: ${arg}`);
      bl.creators.add(arg);
      saveBlacklist(bl.tokens, bl.creators);
      exit(0, `🚫 Creator blacklisted: ${arg}\n   tokens=${bl.tokens.size} creators=${bl.creators.size}`);
    }

    case 'remove-creator': {
      if (!arg) exit(2, 'Нужен <creator>.');
      if (!bl.creators.has(arg)) exit(0, `Не в blacklist: ${arg}`);
      bl.creators.delete(arg);
      saveBlacklist(bl.tokens, bl.creators);
      exit(0, `✅ Creator unblacklisted: ${arg}\n   tokens=${bl.tokens.size} creators=${bl.creators.size}`);
    }

    case 'list': {
      console.log(`\n📋 Blacklist (${BLACKLIST_FILE}):\n`);
      console.log(`Tokens (${bl.tokens.size}):`);
      if (bl.tokens.size === 0) console.log('  (пусто)');
      else for (const t of [...bl.tokens].sort()) console.log(`  ${t}`);
      console.log(`\nCreators (${bl.creators.size}):`);
      if (bl.creators.size === 0) console.log('  (пусто)');
      else for (const c of [...bl.creators].sort()) console.log(`  ${c}`);
      console.log('');
      exit(0);
    }

    case 'stats': {
      console.log(`tokens=${bl.tokens.size} creators=${bl.creators.size}`);
      exit(0);
    }

    case 'clear': {
      // Защита: требуем явное "yes" вторым аргументом.
      if (arg !== 'yes') {
        exit(2, 'Подтверди очистку: blacklist clear yes');
      }
      saveBlacklist(new Set(), new Set());
      exit(0, '🧹 Blacklist полностью очищен');
    }

    default:
      exit(2, `Неизвестная команда: ${cmd}\n\n${USAGE}`);
  }
}

main();
