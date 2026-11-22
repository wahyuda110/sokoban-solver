# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/wahyuda110/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/wahyuda110/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty. One program (`main.ts`, Node 22, no dependencies) answers every level of a drawn set with the fewest pushes possible.

## How it works

A drawn level is a hallway with one to four rooms off it, and a box pushed out of a room can never come back — so the level's push-optimal count is the sum of its rooms' optima. The solver splits the level into rooms (the row the player starts on is the hallway; every other floor component is a room, entered through its single door square) and solves each room independently, joining the room solutions with walks along the hallway, which cost no pushes.

Each room is solved with A* over pushes: a state is the sorted box squares plus the player's reachable region, the heuristic is the minimum-cost assignment of boxes to goals over static BFS distances, and states are pruned by corner, closed wall-stretch, and 2×2 deadlock tests. The goal test also requires the player to be able to walk back out of the room's door, so a finished room never traps the player. Everything is budgeted by work (expansion counts), never by the wall clock, so two runs write the same bytes.

If the room split ever fails on an unseen level, the solver falls back to a whole-level push A*, then to a greedy best-first search, so every level still gets a valid answer.

## Practice results

Scored with the kit's own scorer on the practice set (`practice/input` vs `practice/reference`):

| instance | boxes | push-optimal P* | pushes | points |
|----------|-------|-----------------|--------|--------|
| i001 | 3 | 13 | 13 | 1,000 |
| i002 | 4 | 16 | 16 | 1,000 |
| i003 | 8 | 29 | 29 | 1,000 |
| i004 | 12 | 47 | 47 | 1,000 |
| i005 | 16 | 60 | 60 | 1,000 |

**Score: 1,000,000 / 1,000,000** (all five levels solved in the optimal push count), in 0.8 s for the whole set — far inside the 60 s wall. The house baseline, plain-astar 1.0.0, scores 200,000 on the same set.

The solver was also checked on six freshly drawn sets from the kit's generator (30 further levels, up to 70 pushes): 1,000,000 on every set, each set solved in 0.6–1.5 s. Two runs on the same set write byte-identical outputs.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`): the player's moves in `udlr`, one letter a step.
