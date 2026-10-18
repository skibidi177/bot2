import { REST, Routes } from 'discord.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { commandModules } from './commands.js';

/** Registers slash commands globally, or to DISCORD_GUILD_ID when set (dev). */
async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL, 'deploy');
  if (!env.DISCORD_TOKEN || !env.DISCORD_CLIENT_ID) {
    logger.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required');
    process.exit(1);
  }
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
  const body = commandModules.map((m) => m.data.toJSON());
  if (env.DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), { body });
    logger.info({ guild: env.DISCORD_GUILD_ID, commands: body.length }, 'guild commands deployed');
  } else {
    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body });
    logger.info({ commands: body.length }, 'global commands deployed (may take up to 1h to propagate)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
