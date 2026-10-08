import { useLayoutEffect, useRef } from 'react';
import { RACERS, TRACKS } from '../game/content';
import type { PublicGameView } from '../game/public';
import { AthleteArt, Sparkle } from './Artwork';

export function Board({ game, speed='normal' }: { game: Pick<PublicGameView, 'track' | 'racers' | 'players' | 'turn'>; speed?: 'normal'|'fast'|'off' }) {
  const root=useRef<HTMLElement>(null);
  const positions=useRef<Record<string,{x:number;y:number}>>({});
  useLayoutEffect(()=>{const el=root.current;if(!el)return;const origin=el.getBoundingClientRect();const next:Record<string,{x:number;y:number}>={};
    el.querySelectorAll<HTMLElement>('[data-pawn]').forEach(pawn=>{const id=pawn.dataset.pawn!;const rect=pawn.getBoundingClientRect();next[id]={x:rect.left-origin.left,y:rect.top-origin.top};const old=positions.current[id];if(old&&speed!=='off'&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){const dx=old.x-next[id].x,dy=old.y-next[id].y;if(dx||dy)pawn.animate([{transform:`translate(${dx}px,${dy}px)`,zIndex:10},{transform:'translate(0,0)',zIndex:10}],{duration:speed==='fast'?95:320,easing:'cubic-bezier(.2,.7,.3,1)'});}});positions.current=next;
  },[game,speed]);
  const track = TRACKS[game.track];
  const count = track.length + 2;
  const cols = 8;
  const rows = Math.ceil(count / cols);
  const cells = Array.from({ length: count }, (_, position) => {
    const row = Math.floor(position / cols);
    const col = row % 2 === 0 ? position % cols : cols - 1 - position % cols;
    const special = track.spaces[position];
    const occupants = game.racers.filter(r => r.position === position && !r.eliminated);
    return <div key={position} className={`track-cell ${position === 0 ? 'start' : ''} ${position === count - 1 ? 'finish' : ''} ${special ? 'special ' + special.kind : ''}`} style={{ gridRow: row + 1, gridColumn: col + 1 }} data-testid={`space-${position}`}>
      <span className="space-number">{position === 0 ? '起点' : position === count - 1 ? '终点' : position}</span>
      {special && <span className="space-effect" title={special.kind === 'move' ? `移动 ${special.amount} 格` : special.kind === 'trip' ? '绊倒' : '奖励星'}>{special.kind === 'move' ? `${(special.amount ?? 0) > 0 ? '+' : ''}${special.amount}` : special.kind === 'trip' ? '↯' : '★'}</span>}
      {position === count - 1 && <span className="finish-flag">⚑</span>}
      <div className={`occupants count-${occupants.length}`}>{occupants.map(r => <div key={r.id} data-pawn={r.id} className={`pawn ${game.turn?.actor === r.id ? 'active' : ''} ${r.tripped ? 'tripped' : ''}`} style={{ '--player-color': game.players[r.playerId]?.color } as React.CSSProperties} title={`${game.players[r.playerId]?.name} · ${RACERS[r.id].name}${r.tripped ? '（绊倒）' : ''}`}>
        <AthleteArt id={r.id} color={RACERS[r.id].color} small /><span>{RACERS[r.id].name}</span><i>{r.playerId + 1}</i>
      </div>)}</div>
      {position !== count - 1 && <span className="path-arrow">{position % cols === cols - 1 ? '↓' : row % 2 === 0 ? '→' : '←'}</span>}
    </div>;
  });
  return <section ref={root} className={`board-panel ${game.track}`} aria-label={`${track.name}棋盘`}>
    <div className="board-heading"><div><span className="eyebrow">THE RACE IS ON</span><h2>{track.name}<span className="track-tag">{game.track === 'mild' ? '温和赛道' : '狂野赛道'}</span></h2></div><Sparkle className="board-spark"/></div>
    <div className="track-grid" style={{ gridTemplateRows: `repeat(${rows}, minmax(90px, 1fr))` }}>{cells}</div>
    <div className="board-legend"><span><b>→</b> 按箭头方向前进</span><span><b>↯</b> 绊倒</span><span><b>★</b> 奖励星</span><span className="muted">棋子数字对应玩家编号</span></div>
  </section>;
}
