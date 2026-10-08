/** Rule data, checked against IELLO's visible rulebook, August 2026 FAQ and board photos. */
export const RULES_VERSION = 'cmyk-base-2026-08-28';

export interface RacerDef {
  id: string;
  name: string;
  english: string;
  description: string;
  color: string;
  symbol: string;
}

export interface TrackDef {
  id: 'mild' | 'wild';
  name: string;
  /** Start is 0; spaces 1..length are on track; length + 1 crosses the finish. */
  length: number;
  secondCorner: number;
  spaces: Record<number, { kind: 'move' | 'trip' | 'star'; amount?: number }>;
}

const entries: Array<[string, string, string, string, string, string]> = [
  ['alchemist', '炼金术士', 'Alchemist', '主要移动掷出 1 或 2 时，可以改为移动 4 格；再应用其他移动修正。', '#b1c866', '⚗'],
  ['baba_yaga', '鸡脚屋', 'Baba Yaga', '有运动员停到你的格子，或你停到已有运动员的格子，使对方绊倒。一起到达的运动员之间不触发。', '#92bdda', '⌂'],
  ['banana', '香蕉', 'Banana', '其他运动员一次移动从你的一侧越到另一侧时，使其绊倒。先完成移动，再处理绊倒；同格出发不算超越。', '#f4cf59', '◕'],
  ['blimp', '飞艇', 'Blimp', '回合开始时在第二个拐角之前，主要移动 +3；在该拐角或之后，主要移动 −1。', '#b8d5d5', '◉'],
  ['centaur', '半人马', 'Centaur', '移动超越其他运动员时，使被超越者后退 2 格；后退不能越过起点。', '#d99975', '♞'],
  ['cheerleader', '啦啦队长', 'Cheerleader', '回合开始时，可以让所有并列最后的运动员同时前进 2 格，然后自己前进 1 格。自己也可能受益。', '#dca0c2', '✺'],
  ['coach', '教练', 'Coach', '与你同格的所有运动员，包含你自己，主要移动 +1。', '#a9c67f', '⚑'],
  ['copycat', '模仿猫', 'Copycat', '持续拥有当前领先运动员的能力；并列时选择一位。不复制赛前能力，冲突时原角色优先。独自领先时没有其他能力。', '#a7afdc', '♧'],
  ['dicemonger', '骰子商人', 'Dicemonger', '任何运动员每回合可将主要移动骰额外重掷一次。别人使用这次机会时，你先前进 1 格，再掷新骰。', '#e4b173', '⚄'],
  ['duelist', '决斗家', 'Duelist', '与另一位运动员同格时，可以发起决斗。双方掷骰，点数高者前进 2 格；平局你获胜。不能打断正在执行的动作。', '#a7b8e7', '⚔'],
  ['egg', '蛋蛋', 'Egg', '赛前从未使用牌堆抽出 3 名运动员，选择其中一位，复制其能力；包含赛前能力，仍保留自己的身份。', '#e8b55b', '◒'],
  ['flip_flop', '人字拖', 'Flip Flop', '可以用与另一位在赛运动员交换位置，代替掷骰和主要移动。交换属于双方同时传送。', '#d9a4db', '⇄'],
  ['genius', '天才', 'Genius', '掷主要移动骰之前，可以预测点数。最终结果猜中，在完整结算当前回合后再进行一回合。', '#e1c86c', '✧'],
  ['gunk', '黏液怪', 'Gunk', '其他所有运动员的主要移动 −1。改变移动距离，不改变骰子点数；多个黏液能力可以叠加。', '#c6c987', '≈'],
  ['hare', '野兔', 'Hare', '主要移动 +2；如果回合开始时独自领先，则跳过这次主要移动，不获得额外分数。', '#92cbd1', '♧'],
  ['heckler', '起哄者', 'Heckler', '任何运动员完整结束回合时，如果距本回合起始位置不超过 1 格，你前进 2 格。自己也会触发。', '#cf8aa9', '♪'],
  ['huge_baby', '巨婴', 'Huge Baby', '除起点外，其他运动员不能与你同格；发生这种情况时，把其他运动员放到你后面 1 格。这是停格，不是移动。', '#dfa6bc', '●'],
  ['hypnotist', '催眠师', 'Hypnotist', '回合开始时，可以选择一位运动员，将其传送到你的格子。传送后的停格效果正常结算。', '#c0b4df', '◎'],
  ['inchworm', '尺蠖', 'Inchworm', '其他运动员最终主要移动骰为 1 时，取消其主要移动，改为你前进 1 格。', '#b9cb75', '∿'],
  ['lackey', '跟班', 'Lackey', '其他运动员最终主要移动骰为 6 时，在其移动之前，你先前进 2 格。', '#d7b2cd', '✋'],
  ['leaptoad', '跳跳蟾蜍', 'Leaptoad', '任何移动都跳过被其他运动员占据的格子，只计算空格；向后移动同样适用。', '#91c3a0', '↟'],
  ['legs', '大长腿', 'Legs', '可以不掷主要移动骰，改为主要移动 5 格。教练、黏液怪等距离修正仍然适用。', '#96bd93', 'Ⅱ'],
  ['lovable_loser', '可爱的倒霉蛋', 'Lovable Loser', '回合开始时，如果独自处于最后一名，获得 1 分。绊倒时仍然能获得。', '#d7aec7', '♡'],
  ['magician', '魔术师', 'Magician', '每次主要移动可以重掷骰子最多两次；必须使用最后一次结果，放弃的点数不触发点数相关技能。', '#b9a1ce', '✦'],
  ['mastermind', '幕后军师', 'Mastermind', '本场第一次回合开始时，预测一位冠军。预测正确时，你立即获得亚军并结束比赛；预测自己可同时获得冠军和亚军。', '#92bad3', '◇'],
  ['mouth', '大嘴怪', 'M.O.U.T.H.', '你停到已经恰好有一位其他运动员的格子时，淘汰对方。对方主动停到你处不触发；同时到达不互相触发。', '#97c5a9', '▰'],
  ['party_animal', '派对动物', 'Party Animal', '回合开始时，其他运动员同时向你移动 1 格。与你同格的每一位其他运动员，使你的主要移动 +1。', '#e3a469', '♬'],
  ['rocket_scientist', '火箭科学家', 'Rocket Scientist', '掷出主要移动骰后，可以将该点数翻倍，再应用其他距离修正。若翻倍，完成移动后自己绊倒。', '#d6a0c4', '↑'],
  ['romantic', '浪漫家', 'Romantic', '有人停到已经恰好有一位其他运动员的格子时，你前进 2 格。自己也能触发；共同到达的运动员之间不触发。', '#d59abc', '♥'],
  ['scoocher', '蹭蹭怪', 'Scoocher', '其他运动员的能力实际发动一次，你前进 1 格。连续效果可能反复触发；真正重复同一状态的循环只执行一次。', '#cba786', '↦'],
  ['sisyphus', '西西弗斯', 'Sisyphus', '赛前获得 4 分。最终主要移动骰为 6 时，代替移动，传送回起点并失去 1 分；总分最低为 0。', '#b7b8aa', '◍'],
  ['skipper', '船长', 'Skipper', '任何运动员最终主要移动骰为 1 时，你成为下一位行动者，随后顺序从你之后继续。自己掷出 1 也会触发。', '#deb264', '⚓'],
  ['stickler', '较真怪', 'Stickler', '其他运动员必须恰好移动到终点线才能冲线。超过所需距离时，整次移动取消；所有类型的移动均受影响。', '#c89fc7', '≡'],
  ['suckerfish', '吸盘鱼', 'Suckerfish', '同格另一位运动员开始移动时，你可以跟随到它的终点，双方同时到达。不能跟随传送；冲线名次排在被跟随者之后。', '#a9c38b', '⊙'],
  ['third_wheel', '电灯泡', 'Third Wheel', '回合开始时，可以传送到恰好有两位运动员的格子，结算停格效果后仍进行主要移动。', '#c9adce', '◴'],
  ['twin', '双胞胎', 'Twin', '赛前可以选择之前一场比赛的冠军，复制其能力，包含赛前能力。仍保留自己的身份。', '#c6cf80', '∞'],
];

export const RACERS: Record<string, RacerDef> = Object.fromEntries(
  entries.map(([id, name, english, description, color, symbol]) => [id, { id, name, english, description, color, symbol }]),
);

export const TRACKS: { mild: TrackDef; wild: TrackDef } = {
  mild: { id: 'mild', name: '轻松一圈', length: 29, secondCorner: 15, spaces: {} },
  wild: {
    id: 'wild', name: '狂野赛道', length: 29, secondCorner: 15,
    spaces: {
      1: { kind: 'star', amount: 1 },
      5: { kind: 'trip' },
      7: { kind: 'move', amount: 3 },
      11: { kind: 'move', amount: 1 },
      13: { kind: 'star', amount: 1 },
      16: { kind: 'move', amount: -4 },
      17: { kind: 'trip' },
      23: { kind: 'move', amount: 2 },
      24: { kind: 'move', amount: -2 },
      26: { kind: 'trip' },
    },
  },
};

/** [gold, silver] for each race; the middle two rounds intentionally match. */
export const AWARDS: number[][] = [[3, 1], [4, 2], [4, 2], [5, 3]];
