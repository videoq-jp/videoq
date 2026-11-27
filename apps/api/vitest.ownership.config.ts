import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';
import { ownershipMutation } from './scripts/ownership/mutation-plugin.mjs';
export default mergeConfig(base, defineConfig({ plugins:[ownershipMutation()], test:{maxWorkers:2,fsModuleCache:false} }));
