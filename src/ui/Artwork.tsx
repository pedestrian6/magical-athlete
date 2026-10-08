import { useId } from 'react';

export function Sparkle({ className = '' }: { className?: string }) {
  return <svg viewBox="0 0 40 40" className={className} aria-hidden="true"><path d="M20 2c2 12 6 16 18 18-12 2-16 6-18 18C18 26 14 22 2 20 14 18 18 14 20 2Z" fill="currentColor" /></svg>;
}
export function AthleteArt({ id, color = '#a894d7', small = false }: { id: string; color?: string; small?: boolean }) {
  const uid = useId().replace(/:/g, '');
  const hash = [...id].reduce((n, c) => n + c.charCodeAt(0), 0);
  const style = hash % 6;
  return <svg viewBox="0 0 160 160" className={small ? 'athlete-art small' : 'athlete-art'} aria-hidden="true">
    <defs><pattern id={uid} width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.2" fill="#342743" opacity=".12" /></pattern></defs>
    {!small && <><circle cx="80" cy="79" r="68" fill={color} opacity=".24"/><circle cx="80" cy="79" r="68" fill={`url(#${uid})`}/><path d="m20 47 8 2-4 8-3-6-7 1ZM126 33l6-10 3 11 11 3-11 4-4 10-3-11-11-3Z" fill={color}/></>}
    <g stroke="#30253b" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M59 113 45 136l-14 2m64-25 21 22 14-3" fill="none" />
      <path d="m56 92-23 6-10-11m84 6 22-14 8 4" fill="none" />
      <path d="M58 84q-17 9-15 29 33 15 68-1-1-20-19-29" fill={color}/>
      <path d="m70 108 6 7 11-17" fill="none" stroke="#fff9ea"/>
      {style === 0 && <path d="M49 57 61 17l18 27 23-28 10 43" fill={color}/>}
      {style === 1 && <path d="M52 54 73 8l11 21 22 27Z" fill={color}/>}
      {style === 2 && <><path d="M53 49 34 30l-1 34m73-15 18-19 5 31" fill={color}/></>}
      {style === 3 && <path d="M52 50q-13-30 5-28l20 27 17-25q19-9 13 30" fill={color}/>}
      {style === 4 && <path d="m47 52-7-22 25 9L77 19l14 21 28-11-9 32" fill="#edb85b"/>}
      {style === 5 && <path d="M49 58q-13-48 26-36 37-16 40 26l-3 11" fill={color}/>}
      <path d="M46 65q-2-24 32-26 36-2 38 29l-4 19q-8 21-33 20-28-1-34-24Z" fill="#fff0d7"/>
      {style === 2 && <path d="m46 63 28 6 8-5 28-4-5 16-23 2-7-6-20 5Z" fill={color}/>}
      <path d="M64 65v7m31-7v7"/>
      <path d="M73 85q8 8 16-1" fill="none" />
      <path d="m80 68-3 9h7" strokeWidth="2" fill="none"/>
      <path d="M55 82h6m39 0h6" stroke="#df927e" strokeWidth="5"/>
      {style === 1 && <path d="M43 49q37-14 77 1" fill="none"/>}
    </g>
  </svg>;
}
export function Die({ value, rolling = false }: { value: number | null; rolling?: boolean }) {
  const dots: Record<number, number[][]> = { 1: [[50,50]], 2:[[28,28],[72,72]], 3:[[28,28],[50,50],[72,72]], 4:[[28,28],[72,28],[28,72],[72,72]], 5:[[28,28],[72,28],[50,50],[28,72],[72,72]], 6:[[28,25],[72,25],[28,50],[72,50],[28,75],[72,75]] };
  return <svg className={`die ${rolling ? 'rolling' : ''}`} viewBox="0 0 100 100" role="img" aria-label={value ? `骰子 ${value} 点` : '等待掷骰'}><rect x="7" y="10" width="88" height="88" rx="23" fill="#30253b"/><rect x="4" y="3" width="88" height="88" rx="23" fill="#fffaf0" stroke="#30253b" strokeWidth="3"/>{value ? dots[value]?.map(([x,y],i)=><circle key={i} cx={x-2} cy={y-4} r="7" fill="#55417b"/>) : <path d="M50 23c2 13 6 17 19 20-13 3-17 7-19 20-3-13-7-17-20-20 13-3 17-7 20-20Z" fill="#9b7bc8"/>}</svg>;
}
