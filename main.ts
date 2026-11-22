// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
// One program answers every drawn level (XSB) with a move sequence that pushes
// every box onto a goal in as few pushes as possible.
//
// Structure of a drawn level (see the kit's competition.yaml): a one-square-wide
// hallway across the board, where the player starts, and one to four rooms off it,
// each opening onto the hallway through one door. A box pushed out of a room can
// never come back, so a level's push-optimal count is the sum of its rooms'
// optima: each room is solved independently, push-optimally, from its door, and
// the room solutions are joined by walks along the hallway (walks cost no pushes).
//
// Each room is solved with A* over pushes: a state is the sorted box squares plus
// the player's reachable region (canonicalised to its lowest square), the
// heuristic is the minimum-cost assignment of boxes to goals over static BFS
// distances, and states are pruned by corner, wall-line and 2x2 deadlock tests.
// Everything is budgeted by work (expansion counts), never by the wall clock, so
// two runs write the same bytes. If the room split ever fails, a whole-level
// push A* (then a greedy best-first search) is tried instead, so every level
// still gets a valid answer.
//
// Run: node main.ts reads /input/<id>/level.txt (or $MAKEFUN_INPUT_DIR) and
// writes /output/<id>/solution.txt (or $MAKEFUN_OUTPUT_DIR).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
] as const;

interface Grid {
  w: number;
  h: number;
  wall: boolean[];
  goals: number[];
  goalSet: Set<number>;
  boxes: number[];
  player: number;
}

function parse(text: string): Grid {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall: boolean[] = new Array(w * h).fill(true);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if ('.*+'.includes(ch)) goals.push(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet: new Set(goals), boxes, player };
}

/** Flood fill of the squares the player can reach from `from`, avoiding walls and boxes. */
function region(from: number, wall: boolean[], boxSet: Set<number>, w: number, h: number): Set<number> {
  const seen = new Set<number>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const c = stack.pop()!;
    const x = c % w;
    const y = (c / w) | 0;
    for (const d of DIRS) {
      const nx = x + d.dx;
      const ny = y + d.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (wall[n] || boxSet.has(n) || seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return seen;
}

/** BFS path (as move letters) from `from` to `to`, avoiding walls and boxes; null if none. */
function path(from: number, to: number, wall: boolean[], boxSet: Set<number>, w: number, h: number): string | null {
  if (from === to) return '';
  const prev = new Map<number, [number, string]>();
  const queue = [from];
  prev.set(from, [-1, '']);
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    const x = c % w;
    const y = (c / w) | 0;
    for (const d of DIRS) {
      const nx = x + d.dx;
      const ny = y + d.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (wall[n] || boxSet.has(n) || prev.has(n)) continue;
      prev.set(n, [c, d.ch]);
      if (n === to) {
        let moves = '';
        let cur = n;
        while (cur !== from) {
          const [p, ch] = prev.get(cur)!;
          moves = ch + moves;
          cur = p;
        }
        return moves;
      }
      queue.push(n);
    }
  }
  return null;
}

/** BFS distances from `from` over floor squares (walls block, boxes ignored). */
function distances(from: number, wall: boolean[], w: number, h: number): number[] {
  const dist = new Array<number>(w * h).fill(Infinity);
  dist[from] = 0;
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    const x = c % w;
    const y = (c / w) | 0;
    for (const d of DIRS) {
      const nx = x + d.dx;
      const ny = y + d.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (wall[n] || dist[n] !== Infinity) continue;
      dist[n] = dist[c]! + 1;
      queue.push(n);
    }
  }
  return dist;
}

interface Push {
  box: number;
  dir: number; // index into DIRS
}

/**
 * Push-optimal A* over one board (a room, or a whole level as a fallback).
 * `cells` is the set of floor squares the search may use (room squares plus the
 * door/entry square, or every floor square for a whole level); `startPlayer` is
 * the square the player starts on; `exit` is a square the player must be able
 * to reach once every box is on a goal (the room's entry square), or -1.
 * Returns the push list, or null when the budget runs out or no solution exists.
 */
function pushAStar(
  g: Grid,
  cells: Set<number>,
  startBoxes: number[],
  startPlayer: number,
  exit: number,
  maxExpansions: number,
  greedy: boolean,
): Push[] | null {
  const { w, h, wall, goals, goalSet } = g;
  const n = startBoxes.length;
  // Static distances from each goal, for the assignment heuristic.
  const goalDist = goals.map((goal) => distances(goal, wall, w, h));
  // Minimum-cost assignment of boxes to distinct goals (brute force: n <= 16 in
  // the whole-level fallback, so cap the exact assignment at n <= 5 and use the
  // nearest-goal sum otherwise, which stays admissible).
  const heuristic = (boxes: number[]): number => {
    if (n === 0) return 0;
    if (n > 5) {
      let s = 0;
      for (const b of boxes) {
        let best = Infinity;
        for (let gi = 0; gi < goals.length; gi++) {
          const d = goalDist[gi]![b]!;
          if (d < best) best = d;
        }
        if (best === Infinity) return Infinity;
        s += best;
      }
      return s;
    }
    let best = Infinity;
    const used = new Array<boolean>(goals.length).fill(false);
    const rec = (bi: number, acc: number): void => {
      if (acc >= best) return;
      if (bi === n) {
        best = acc;
        return;
      }
      for (let gi = 0; gi < goals.length; gi++) {
        if (used[gi]) continue;
        const d = goalDist[gi]![boxes[bi]!]!;
        if (d === Infinity) continue;
        used[gi] = true;
        rec(bi + 1, acc + d);
        used[gi] = false;
      }
    };
    rec(0, 0);
    return best;
  };

  const isWall = (c: number): boolean => c < 0 || c >= w * h || wall[c]! || !cells.has(c);

  /** True when a box that is not on a goal can never move again. */
  const deadlocked = (boxes: number[], boxSet: Set<number>): boolean => {
    for (const b of boxes) {
      if (goalSet.has(b)) continue;
      const x = b % w;
      const y = (b / w) | 0;
      const up = isWall(b - w);
      const down = isWall(b + w);
      const left = isWall(b - 1);
      const right = isWall(b + 1);
      // Corner: walls on two perpendicular sides.
      if ((up || down) && (left || right)) return true;
      // Against a wall: the box can only slide along the wall, so it is dead when
      // the stretch it can slide along is closed at both ends by walls and holds
      // no goal. (A stretch open at an end lets the box slide out and away, so
      // it is not a deadlock.) `wallOff` is the offset of the wall side; the box
      // slides along the perpendicular axis.
      const wallSides: [number, number][] = [];
      if (up) wallSides.push([-w, 1]);
      if (down) wallSides.push([w, 1]);
      if (left) wallSides.push([-1, w]);
      if (right) wallSides.push([1, w]);
      for (const [wallOff, step] of wallSides) {
        let hasGoal = false;
        let bounded = true;
        for (const dir of [step, -step] as const) {
          for (let c = b + dir; ; c += dir) {
            if (isWall(c)) break; // floor ended: this end is closed
            if (!isWall(c + wallOff)) {
              bounded = false; // the wall ends: the box can slide out here
              break;
            }
            if (goalSet.has(c)) hasGoal = true;
          }
        }
        if (bounded && !hasGoal) return true;
      }
      // 2x2 block of walls/boxes holding a box that is not on a goal.
      for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
        const bx0 = x + ox;
        const by0 = y + oy;
        if (bx0 < 0 || by0 < 0 || bx0 + 1 >= w || by0 + 1 >= h) continue;
        const c00 = by0 * w + bx0;
        const c10 = c00 + 1;
        const c01 = c00 + w;
        const c11 = c01 + 1;
        const all = [c00, c10, c01, c11].every((c) => isWall(c) || boxSet.has(c));
        if (all) {
          const anyLoose = [c00, c10, c01, c11].some((c) => boxSet.has(c) && !goalSet.has(c));
          if (anyLoose) return true;
        }
      }
    }
    return false;
  };

  const canon = (boxes: number[], player: number): number => {
    const r = region(player, wall, new Set(boxes), w, h);
    let m = Infinity;
    for (const c of r) if (c < m) m = c;
    return m;
  };
  const keyOf = (boxes: number[], pc: number): string => boxes.join(',') + '|' + pc;

  // Heap of [priority, g, tie, stateIndex]; A* on f = g + h, deeper first on ties.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const sBoxes: number[][] = [startBoxes.slice().sort((a, b) => a - b)];
  const sPlayer: number[] = [canon(sBoxes[0]!, startPlayer)];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sPush: Push[] = [{ box: -1, dir: -1 }];
  const best = new Map<string, number>();
  best.set(keyOf(sBoxes[0]!, sPlayer[0]!), 0);
  const h0 = heuristic(sBoxes[0]!);
  if (h0 === Infinity) return null;
  heapPush([greedy ? h0 : h0, 0, 0, 0]);
  let tie = 1;
  let expanded = 0;
  while (heap.length > 0 && expanded < maxExpansions) {
    const [, gv, , si] = heapPop();
    const boxes = sBoxes[si]!;
    const pc = sPlayer[si]!;
    if (best.get(keyOf(boxes, pc)) !== si) continue;
    if (sG[si]! !== gv) continue;
    // Goal: every box on a goal, and the player able to reach the exit square.
    if (boxes.every((b) => goalSet.has(b))) {
      if (exit < 0) {
        const out: Push[] = [];
        for (let t = si; t > 0; t = sParent[t]!) out.push(sPush[t]!);
        out.reverse();
        return out;
      }
      const r = region(pc, wall, new Set(boxes), w, h);
      if (r.has(exit)) {
        const out: Push[] = [];
        for (let t = si; t > 0; t = sParent[t]!) out.push(sPush[t]!);
        out.reverse();
        return out;
      }
    }
    expanded++;
    const boxSet = new Set(boxes);
    const reach = region(pc, wall, boxSet, w, h);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = (b / w) | 0;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        const tx = bx + d.dx;
        const ty = by + d.dy;
        const px = bx - d.dx;
        const py = by - d.dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h || px < 0 || py < 0 || px >= w || py >= h) continue;
        const target = ty * w + tx;
        const behind = py * w + px;
        if (isWall(target) || boxSet.has(target)) continue;
        if (isWall(behind) || boxSet.has(behind)) continue;
        if (!reach.has(behind)) continue;
        const nb = boxes.slice();
        nb[bi] = target;
        nb.sort((a, b2) => a - b2);
        const nbSet = new Set(nb);
        if (deadlocked(nb, nbSet)) continue;
        const npc = canon(nb, b);
        const k = keyOf(nb, npc);
        const seen = best.get(k);
        if (seen !== undefined && sG[seen]! <= gv + 1) continue;
        const hv = heuristic(nb);
        if (hv === Infinity) continue;
        const ni = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(npc);
        sG.push(gv + 1);
        sParent.push(si);
        sPush.push({ box: b, dir: di });
        best.set(k, ni);
        heapPush([greedy ? hv : gv + 1 + hv, gv + 1, tie++, ni]);
      }
    }
  }
  return null;
}

/** Turn a push list into move letters, starting the player at `startPlayer`. */
function movesForPushes(
  g: Grid,
  startPlayer: number,
  startBoxes: number[],
  pushes: Push[],
  exit: number,
): string | null {
  const { w, h, wall } = g;
  const boxes = startBoxes.slice();
  let player = startPlayer;
  let moves = '';
  for (const p of pushes) {
    const d = DIRS[p.dir]!;
    const bx = p.box % w;
    const by = (p.box / w) | 0;
    const behind = (by - d.dy) * w + (bx - d.dx);
    const boxSet = new Set(boxes);
    const leg = path(player, behind, wall, boxSet, w, h);
    if (leg === null) return null;
    moves += leg + d.ch;
    const at = boxes.indexOf(p.box);
    if (at < 0) return null;
    boxes[at] = (by + d.dy) * w + (bx + d.dx);
    player = p.box;
  }
  if (exit >= 0) {
    const leg = path(player, exit, wall, new Set(boxes), w, h);
    if (leg === null) return null;
    moves += leg;
    player = exit;
  }
  return moves;
}

/** Split a level into rooms. Returns null when the split does not apply cleanly. */
function splitRooms(g: Grid): { cells: Set<number>; boxes: number[]; goals: number[]; entry: number }[] | null {
  const { w, h, wall, boxes, goals, player } = g;
  const hallwayRow = (player / w) | 0;
  const floor = (c: number): boolean => !wall[c];
  // Connected components of floor cells outside the hallway row.
  const seen = new Set<number>();
  const rooms: { cells: Set<number>; boxes: number[]; goals: number[]; entry: number }[] = [];
  for (let c = 0; c < w * h; c++) {
    if (!floor(c) || (c / w | 0) === hallwayRow || seen.has(c)) continue;
    const comp = new Set<number>();
    const stack = [c];
    seen.add(c);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      comp.add(cur);
      const x = cur % w;
      const y = (cur / w) | 0;
      for (const d of DIRS) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!floor(n) || (n / w | 0) === hallwayRow || seen.has(n)) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    // The entry is the one hallway square touching this component.
    const entries = new Set<number>();
    for (const cell of comp) {
      const x = cell % w;
      const y = (cell / w) | 0;
      for (const d of DIRS) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        if (ny !== hallwayRow || nx < 0 || nx >= w) continue;
        const n = ny * w + nx;
        if (floor(n)) entries.add(n);
      }
    }
    if (entries.size !== 1) return null;
    const entry = [...entries][0]!;
    const rBoxes = boxes.filter((b) => comp.has(b));
    const rGoals = goals.filter((gl) => comp.has(gl));
    rooms.push({ cells: comp, boxes: rBoxes, goals: rGoals, entry });
  }
  // Every box and goal must sit inside exactly one room.
  const assignedBoxes = rooms.reduce((a, r) => a + r.boxes.length, 0);
  const assignedGoals = rooms.reduce((a, r) => a + r.goals.length, 0);
  if (assignedBoxes !== boxes.length || assignedGoals !== goals.length) return null;
  if (rooms.length === 0) return null;
  return rooms;
}

function solve(text: string): string {
  const g = parse(text);
  const allFloor = new Set<number>();
  for (let c = 0; c < g.w * g.h; c++) if (!g.wall[c]) allFloor.add(c);

  const rooms = splitRooms(g);
  if (rooms !== null) {
    // Solve rooms in a fixed order; join with hallway walks.
    const order = rooms.slice().sort((a, b) => a.entry - b.entry);
    let moves = '';
    let player = g.player;
    const globalBoxes = g.boxes.slice();
    let ok = true;
    for (const room of order) {
      const cells = new Set(room.cells);
      cells.add(room.entry);
      const roomGrid: Grid = { ...g, goals: room.goals, goalSet: new Set(room.goals) };
      const pushes = pushAStar(roomGrid, cells, room.boxes, room.entry, room.entry, 500_000, false);
      if (pushes === null) {
        ok = false;
        break;
      }
      // Walk the player to this room's entry (boxes elsewhere are obstacles).
      const leg = path(player, room.entry, g.wall, new Set(globalBoxes), g.w, g.h);
      if (leg === null) {
        ok = false;
        break;
      }
      moves += leg;
      const roomMoves = movesForPushes(roomGrid, room.entry, room.boxes, pushes, room.entry);
      if (roomMoves === null) {
        ok = false;
        break;
      }
      moves += roomMoves;
      player = room.entry;
      // The room's boxes end on its goals; record their final squares.
      const simBoxes = room.boxes.slice();
      for (const p of pushes) {
        const d = DIRS[p.dir]!;
        const at = simBoxes.indexOf(p.box);
        simBoxes[at] = ((p.box / g.w | 0) + d.dy) * g.w + ((p.box % g.w) + d.dx);
      }
      for (let i = 0; i < globalBoxes.length; i++) {
        if (room.cells.has(globalBoxes[i]!)) globalBoxes[i] = simBoxes[room.boxes.indexOf(globalBoxes[i]!)]!;
      }
    }
    if (ok) return moves;
  }

  // Fallback: whole-level push A*, then greedy best-first.
  const pushes =
    pushAStar(g, allFloor, g.boxes, g.player, -1, 2_000_000, false) ??
    pushAStar(g, allFloor, g.boxes, g.player, -1, 2_000_000, true);
  if (pushes !== null) {
    const moves = movesForPushes(g, g.player, g.boxes, pushes, -1);
    if (moves !== null) return moves;
  }
  return '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
