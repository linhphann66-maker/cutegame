/**
 * monster-sim.mjs — Server-side monster locomotion AI (server-authoritative).
 *
 * Trước đây AI quái chạy trong browser của "host client" rồi gửi snapshot lên;
 * server chỉ validate rồi broadcast lại. Từ giờ server tự mô phỏng:
 * aggro / chase / windup / strike / recover / return / wander, tick 20Hz
 * trong combat-authority.tick(). Client chỉ nhận MONSTERS_UPDATE và nội suy.
 *
 * Dùng chung data ENEMY_TYPES + enemyRoster với client nên tốc độ/tầm đánh/
 * máu/damage khớp với những gì client vẽ. Không dùng obstacle/A* (server không
 * có bản đồ vật cản) — quái đi thẳng; client vẫn vẽ đúng vì vị trí là chuẩn.
 */
import { ENEMY_TYPES } from '../src/enemy-types.ts';
import { BOSS_SKILLS } from '../src/boss-patterns.ts';

const TAU = Math.PI * 2;
// Góc spawn theo zone, mirror công thức placeEnemy() của client (world.ts)
// để quái online đứng ở các vùng quen thuộc như khi chơi solo.
const ZONE_ANGLES = { canyon: 0, meadow: Math.PI / 2, forest: Math.PI, swamp: -Math.PI / 2 };

/** PRNG có seed: vị trí spawn ổn định trong vòng đời của room. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spawnPoint(zone, boss, rng) {
  const base = zone !== undefined && ZONE_ANGLES[zone] !== undefined ? ZONE_ANGLES[zone] + (rng() - .5) * 1.3 : rng() * TAU;
  const d = boss ? 100 + rng() * 24 : 27 + rng() * 97;
  return { x: Math.cos(base) * d, z: Math.sin(base) * d };
}

/**
 * Sinh toàn bộ quái của room từ roster (gọi 1 lần khi state(room) được tạo).
 * s = { planet, roster: Map(id->entry), enemies: Map, environment, scale? }
 */
export function spawnRoomMonsters(s) {
  const rng = mulberry32((Math.random() * 0xffffffff) >>> 0);
  for (const entry of s.roster.values()) {
    const def = ENEMY_TYPES[entry.type];
    if (!def) continue;
    let x, z;
    if (entry.type === 'dragon' && s.environment?.layout?.nest) {
      x = s.environment.layout.nest.x; z = s.environment.layout.nest.z;
    } else {
      const p = spawnPoint(entry.zone, entry.boss, rng);
      x = p.x; z = p.z;
    }
    const dormant = !!entry.dormant;
    // Hard difficulty: máu/damage theo save của room host (difficulty.ts hardScale), giống client spawn solo.
    const scale = s.scale ?? { hp: 1, damage: 1 };
    const baseMaxHp = Math.round(entry.baseMaxHp * scale.hp), baseDamage = entry.baseDamage * scale.damage;
    s.enemies.set(entry.id, {
      ...entry, roster: entry,
      baseMaxHp, baseDamage,
      home: { x, z }, x, z, y: 0,
      hp: dormant ? 0 : baseMaxHp, maxHp: baseMaxHp, damage: baseDamage,
      respawn: dormant ? 999999 : 0, deadUntil: dormant ? Infinity : 0,
      generation: 0, contributors: new Map(), changedAt: Date.now(),
      statuses: {}, shots: [],
      facing: rng() * TAU, phase: 'idle', phaseTime: 0,
      cooldown: rng() * 1.5, stun: 0, targetX: x, targetZ: z,
      bossStage: 1, attackCount: 0, skillCount: 0, skill: '',
      telegraphs: [], skillEffects: [], spinTick: 0,
      titanAttacks: [], titanLift: 0, lift: 0, liftVelocity: 0,
      scaled: false, cast: null, combatAttacks: [], nextCastAt: 0, lastHitAt: 0,
      chargeHit: false,
    });
  }
}

const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

function moveToward(enemy, tx, tz, speed, dt) {
  const dx = tx - enemy.x, dz = tz - enemy.z, d = Math.hypot(dx, dz);
  if (d > 0.05) {
    const step = Math.min(d, speed * dt);
    enemy.x += dx / d * step; enemy.z += dz / d * step;
    enemy.facing = Math.atan2(dx, dz);
    // Giữ quái trong thế giới (bán kính 155 như validate cũ).
    const r = Math.hypot(enemy.x, enemy.z);
    if (r > 155) { enemy.x *= 155 / r; enemy.z *= 155 / r; }
  }
  return d;
}

/**
 * Đòn đánh thường của quái trúng ai thì tự trừ máu người đó qua ctx.hurt —
 * KHÔNG còn chờ host-client báo `damage` nữa.
 */
function strike(enemy, def, ctx, now) {
  const players = ctx.targets();
  if (def.behavior === 'shooter') {
    // Xạ thủ: windup rồi bắn trúng mọi người trong tầm (client vẽ telegraph từ snapshot).
    for (const p of players) {
      if (dist2(p.pose.x, p.pose.z, enemy.x, enemy.z) <= def.reach + enemy.radius) ctx.hurt(p, enemy, 1, 'shot');
    }
    return;
  }
  for (const p of players) {
    if (dist2(p.pose.x, p.pose.z, enemy.x, enemy.z) <= def.reach + 0.6 + enemy.radius) {
      // Summon đứng chắn thì chịu đòn thay (giống logic hurtDecoy cũ).
      if (!ctx.decoy(p, enemy, 1)) ctx.hurt(p, enemy, 1, 'melee');
    }
  }
}

/**
 * Một bước AI cho mọi quái trong room. Chạy trong combat-authority.tick (20Hz).
 * ctx = { targets(): Peer[], hurt(peer,enemy,mult,source), decoy(peer,enemy,mult): boolean,
 *         cast(enemy, skill): void, isTitanSkill(skill): boolean }
 */
export function stepMonsters(s, dt, now, ctx) {
  const players = ctx.targets();
  const t = now / 1000;
  for (const enemy of s.enemies.values()) {
    if (enemy.hp <= 0 || enemy.pending) continue;
    const def = ENEMY_TYPES[enemy.type];
    if (!def) continue;
    // Boss đang trong thời gian telegraph của skill đặc biệt: đứng yên chờ cast,
    // damage/telegraph do hệ thống cast (updateCast) xử lý — sim không chen melee.
    if (enemy.cast && now < enemy.cast.startsAt) continue;
    enemy.cooldown = Math.max(0, enemy.cooldown - dt);
    const statuses = enemy.statuses || {};
    const noAttack = (statuses.blind > 0) || (statuses.sheep > 0) || (statuses.fear > 0);
    const speedScale = (statuses.slow > 0 ? .45 : 1) * (statuses.sheep > 0 ? .45 : 1);

    // --- Aggro: người chơi active gần nhất trong tầm sight ---
    let target = null, best = Infinity;
    for (const p of players) {
      const d = dist2(p.pose.x, p.pose.z, enemy.x, enemy.z);
      if (d < def.sight && d < best) { best = d; target = p; }
    }

    // --- Windup: đếm ngược rồi tung đòn (server tự tính trúng, không chờ client) ---
    if (enemy.phase === 'windup') {
      enemy.phaseTime -= dt;
      if (target) { enemy.targetX = target.pose.x; enemy.targetZ = target.pose.z; enemy.facing = Math.atan2(target.pose.x - enemy.x, target.pose.z - enemy.z); }
      if (enemy.phaseTime <= 0) {
        if (!noAttack && enemy.stun <= 0) {
          if (def.behavior === 'charger') {
            // Charger: hết windup thì lao thẳng tới điểm đã ngắm (targetX/Z).
            enemy.phase = 'charge'; enemy.phaseTime = .75; enemy.chargeHit = false;
          } else {
            strike(enemy, def, ctx, now);
            enemy.phase = 'recover'; enemy.phaseTime = enemy.boss ? .7 : .45; enemy.cooldown = def.cooldown;
          }
        } else {
          enemy.phase = 'recover'; enemy.phaseTime = .45; enemy.cooldown = def.cooldown;
        }
      }
      continue;
    }
    // --- Charge (boar/charger): lao thẳng, trúng 1 lần ---
    if (enemy.phase === 'charge') {
      moveToward(enemy, enemy.targetX, enemy.targetZ, 13, dt);
      if (!enemy.chargeHit && target && dist2(target.pose.x, target.pose.z, enemy.x, enemy.z) < def.reach + .4 + enemy.radius) {
        if (!ctx.decoy(target, enemy, 1.3)) ctx.hurt(target, enemy, 1.3, 'melee');
        enemy.chargeHit = true;
      }
      enemy.phaseTime -= dt;
      if (enemy.phaseTime <= 0) { enemy.phase = 'recover'; enemy.phaseTime = .45; enemy.cooldown = def.cooldown; }
      continue;
    }
    if (enemy.phase === 'recover') {
      enemy.phaseTime -= dt;
      if (enemy.phaseTime <= 0) enemy.phase = 'chase';
      continue;
    }
    if (enemy.stun > 0) { enemy.phase = 'chase'; enemy.telegraphs = []; continue; }

    // --- Leash: đuổi quá xa nhà thì bỏ về (giống client), trừ khi vừa bị đánh ---
    const homeD = dist2(enemy.x, enemy.z, enemy.home.x, enemy.home.z);
    const leash = enemy.type === 'dragon' ? 75 : 30;
    const sinceHit = now - (enemy.lastHitAt || 0);
    const wasChasing = enemy.phase === 'chase';
    const chasing = !!target && (sinceHit < 4000 ||
      (wasChasing ? best < def.sight * 1.6 && homeD < leash : best < def.sight && homeD < leash));
    const returning = !chasing && (wasChasing || enemy.phase === 'return');

    if (returning) {
      enemy.phase = 'return';
      moveToward(enemy, enemy.home.x, enemy.home.z, def.speed * 1.2 * speedScale, dt);
      if (homeD < .8 || def.speed === 0) { enemy.phase = 'idle'; }
      continue;
    }

    if (chasing && target) {
      enemy.phase = 'chase';
      const reach = def.reach + (enemy.boss ? .6 : 0);
      // Boss tới lượt tung skill đặc biệt: dùng hệ thống cast có sẵn (telegraph → area damage).
      if (enemy.boss && BOSS_SKILLS[enemy.type] && now >= (enemy.nextCastAt || 0) && !enemy.cast && best < 35 && !noAttack && enemy.stun <= 0) {
        const skills = BOSS_SKILLS[enemy.type];
        const skill = skills[(enemy.attackCount || 0) % skills.length];
        enemy.attackCount = (enemy.attackCount || 0) + 1;
        ctx.cast(enemy, skill);
        continue;
      }
      const inReach = def.behavior === 'shooter' ? best < def.reach : best < reach + .4;
      if (inReach && enemy.cooldown <= 0 && !noAttack && enemy.stun <= 0) {
        // Bắt đầu windup: client vẽ telegraph từ phase/targetX/targetZ.
        enemy.phase = 'windup'; enemy.phaseTime = def.windup;
        enemy.targetX = target.pose.x; enemy.targetZ = target.pose.z;
        enemy.facing = Math.atan2(target.pose.x - enemy.x, target.pose.z - enemy.z);
        if (def.behavior === 'shooter') enemy.telegraphs = [{ x: enemy.x, z: enemy.z, r: def.reach, delay: def.windup }];
        if (def.behavior === 'charger') { enemy.phaseTime = .7; }
        continue;
      }
      if (def.behavior === 'shooter') {
        // Xạ thủ giữ khoảng cách: quá gần thì lùi, quá xa thì tiến.
        const want = def.reach * .7;
        if (best < want - 1) moveToward(enemy, enemy.x * 2 - target.pose.x, enemy.z * 2 - target.pose.z, def.speed * speedScale, dt);
        else if (best > def.reach) moveToward(enemy, target.pose.x, target.pose.z, def.speed * speedScale, dt);
        else enemy.facing = Math.atan2(target.pose.x - enemy.x, target.pose.z - enemy.z);
        continue;
      }
      if (def.speed === 0) { enemy.facing = Math.atan2(target.pose.x - enemy.x, target.pose.z - enemy.z); continue; } // rooted: đứng yên đánh
      if (best > reach * .8) moveToward(enemy, target.pose.x, target.pose.z, def.speed * speedScale, dt);
      else enemy.facing = Math.atan2(target.pose.x - enemy.x, target.pose.z - enemy.z);
      continue;
    }

    // --- Wander quanh nhà khi không có mục tiêu ---
    enemy.phase = 'idle';
    if (def.speed > 0 && !enemy.boss) {
      const gx = enemy.home.x + Math.sin(t * .25 + enemy.home.z) * 2;
      const gz = enemy.home.z + Math.cos(t * .25 + enemy.home.x) * 2;
      moveToward(enemy, gx, gz, .6 * speedScale, dt);
    }
  }
}
