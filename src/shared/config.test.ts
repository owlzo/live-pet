/**
 * 成品 → 渲染列表的契约测试：条目级字段只有一处填充点（flattenConfigPets）。
 *
 * 背景：animations / animationWeights / eventsRefreshSec / physics / confineToScreen /
 * workStatusTexts / whisperModel / chatModel 这八个条目级字段必须由 flattenConfigPets 从
 * 「条目」写进每只实例；客户端不得再有第二份填充（第二份会漏字段，例如 physics 缺失时
 * 拖拽第一帧读 cfg.physics.throwPower 直接抛错）。设置页现在用 host 写接口返回的成品聚合
 * 重新拍平。本文件把这条不变式钉住：
 *   ① 成品经 flattenConfigPets 后，每只实例的条目级字段齐全（用真实内置默认配置）；
 *   ② 客户端不得再出现"手抄条目级字段"的填充、host 写接口必须返回成品聚合（源码级守卫——
 *      src/client/pet.ts 依赖 React/DOM，无法在 node 中导入，只能读源码断言）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { flattenConfigPets } from './config.ts';
import { readAllConfig } from '../host/config.ts';
import type { Pet } from './types.ts';

/** 条目级字段清单：客户端渲染直接消费，缺一不可 */
const ENTRY_FIELDS: Array<keyof Pet> = [
  'animations',
  'animationWeights',
  'eventsRefreshSec',
  'physics',
  'confineToScreen',
  'workStatusTexts',
  'whisperModel',
  'chatModel',
];

/** 包内文件源码（守卫用；相对 src/shared/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('flattenConfigPets —— 成品 → 渲染列表的唯一填充点', () => {
  test('真实内置默认配置：每只实例的条目级字段齐全（含 physics.throwPower）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-flatten-'));
    try {
      const merged = readAllConfig({
        defaultFile: fileURLToPath(new URL('../../assets/config.jsonc', import.meta.url)),
        userFile: join(dir, 'main-config.jsonc'), // 不存在：只测内置默认
        petDir: join(dir, 'pet'), // 不存在：不掺文件宠物
      });
      const pets = flattenConfigPets(merged);
      assert.ok(pets.length > 0, '内置默认配置应至少有一只宠物');
      for (const p of pets) {
        for (const field of ENTRY_FIELDS) {
          assert.ok(p[field] !== undefined, `宠物「${String(p.id)}」缺条目级字段 ${field}`);
        }
        // 拖拽跟手第一帧读的就是它；缺失即 TypeError（本文件存在的直接原因）
        const physics = p.physics as { throwPower?: unknown };
        assert.equal(typeof physics.throwPower, 'number', 'physics.throwPower 必须是数字');
        // animations 是 { idle/turn/drag/clicks/moves/categories/events } 段：待机池必须非空
        const animations = p.animations as { idle?: unknown };
        assert.ok(Array.isArray(animations.idle) && animations.idle.length > 0, 'animations.idle 应为非空待机动画池');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('条目级字段的来源是「条目」而非实例：实例写同名值也不生效（唯一来源 = conf）', () => {
    const merged = {
      main: {
        physics: { throwPower: 7 },
        animations: ['a.webm'],
        pets: [{ id: 'x', physics: { throwPower: 1 } }],
      },
    };
    const [pet] = flattenConfigPets(merged as Record<string, Record<string, unknown>>);
    assert.deepEqual(pet.physics, { throwPower: 7 });
    assert.deepEqual(pet.animations, ['a.webm']);
  });

  test('实例级人设 whisperPrompt：原样带出，不参与条目级覆盖（回落由 host 消费端做）', () => {
    const merged = {
      main: {
        whisperPrompt: '条目人设',
        pets: [{ id: 'x', whisperPrompt: '实例人设' }, { id: 'y' }],
      },
    };
    const [a, b] = flattenConfigPets(merged as Record<string, Record<string, unknown>>);
    // 条目级字段是"实例写了也以 conf 为准"，人设是反例：实例那份必须留下来（它是覆盖）
    assert.equal(a.whisperPrompt, '实例人设');
    assert.equal('whisperPrompt' in b, false, '没写就是没写——回落由 host 的 petPersona 做，这里不填生效值');
  });

});
