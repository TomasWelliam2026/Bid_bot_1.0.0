import { useEffect, useRef, useState } from 'react';

/**
 * One tab per country the archive tracks, and a "+" to add another. Renaming
 * and deleting a tab live in its own settings panel (the gear icon), not
 * here -- this strip is just which one is on screen.
 *
 * Replaces the old global Automatic/Human-check switch: that choice is now
 * each tab's own (it lives alongside the rest of that tab's settings), so
 * there is nothing left here to toggle -- only which tab's applications are
 * on screen.
 */
export default function UserTabs({ users, activeId, onSelect, onCreate, pendingByUser }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const wrap = useRef(null);
  const input = useRef(null);

  // Same dismiss behaviour as the Sheet sync / CSV popovers: Escape, or a
  // click anywhere outside it.
  useEffect(() => {
    if (!adding) return undefined;
    input.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') setAdding(false);
    };
    const onDown = (event) => {
      if (!wrap.current?.contains(event.target)) setAdding(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [adding]);

  const openAdd = () => {
    setName('');
    setError(null);
    setAdding(true);
  };

  const create = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const result = await onCreate(trimmed);
    setBusy(false);
    if (result?.error) {
      setError(result.error);
      return;
    }
    if (result?.user) onSelect(result.user.id);
    setAdding(false);
  };

  const badge = (key) => (pendingByUser[key] ? <span className="tab-pending">{pendingByUser[key]}</span> : null);

  return (
    <div className="tabs-wrap" ref={wrap}>
      <div className="switch tabs" role="tablist" aria-label="Which country's applications to show">
        {users.map((user) => (
          <button
            key={user.id}
            type="button"
            role="tab"
            aria-selected={activeId === user.id}
            className={activeId === user.id ? 'seg on' : 'seg'}
            onClick={() => onSelect(user.id)}
          >
            {user.name}
            {badge(user.id)}
          </button>
        ))}
        <button type="button" className="seg-add" onClick={openAdd} title="Add a tab for another country">
          +
        </button>
      </div>

      {adding ? (
        <div className="popover newtab" role="dialog" aria-label="Add a tab">
          <form onSubmit={create} className="newtab-form">
            <label className="field">
              <span>Country</span>
              <input
                ref={input}
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. United States"
              />
            </label>
            <div className="save-row">
              <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
                {busy ? 'Adding…' : 'Add tab'}
              </button>
            </div>
            {error ? <div className="note critical">{error}</div> : null}
          </form>
        </div>
      ) : null}
    </div>
  );
}
