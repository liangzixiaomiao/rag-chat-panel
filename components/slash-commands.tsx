'use client';

import type { CommandSpec } from '@/lib/commands';

interface SlashCommandsProps {
  commands: readonly CommandSpec[];
  onPick: (command: CommandSpec) => void;
}

/** 输入框只打了 "/" 时弹出的指令列表；只负责展示与选择，不发请求。 */
export default function SlashCommands({ commands, onPick }: SlashCommandsProps) {
  return (
    <div
      style={{
        border: '1px solid #ccc',
        borderRadius: 4,
        background: '#fff',
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div style={{ color: '#888', fontSize: 12, padding: '2px 6px' }}>选择一个指令</div>
      {commands.map((command) => (
        <button
          key={command.name}
          type="button"
          onClick={() => onPick(command)}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'baseline',
            border: 'none',
            background: 'transparent',
            padding: '4px 6px',
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        >
          <span style={{ color: '#333', fontWeight: 600 }}>/{command.name}</span>
          <span style={{ color: '#666', fontSize: 12 }}>{command.description}</span>
        </button>
      ))}
    </div>
  );
}
