import { useState, useRef } from "react";

interface Props {
  disabled: boolean;
  onSend: (content: string) => void;
  onInterrupt: () => void;
  showInterrupt: boolean;
}

export function MessageInput({ disabled, onSend, onInterrupt, showInterrupt }: Props) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
    inputRef.current?.focus();
  };

  return (
    <div className="input-bar">
      <input
        ref={inputRef}
        type="text"
        placeholder="Send a message..."
        disabled={disabled}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSend()}
      />
      <button disabled={disabled} onClick={handleSend}>
        Send
      </button>
      {showInterrupt && (
        <button className="danger" onClick={onInterrupt}>
          Interrupt
        </button>
      )}
    </div>
  );
}
