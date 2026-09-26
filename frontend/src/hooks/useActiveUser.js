import { useEffect, useState } from 'react';

const KEY = 'jobsaver.activeTab';

function readStored() {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeStored(id) {
  try {
    localStorage.setItem(KEY, String(id));
  } catch {
    // The choice just does not outlive this browser tab.
  }
}

/**
 * Which tab this browser is looking at -- not archive state, just this
 * browser's own place in it, kept across reloads.
 *
 * Every tab is a real one now (there is no Unassigned to fall back to), so
 * this has to correct itself whenever the current choice stops being valid,
 * not just once at first load: a stored id for a tab that no longer exists,
 * nothing stored yet, or the active tab being deleted out from under this
 * browser mid-session, all land on the first remaining tab. `null` only
 * means "no tabs exist at all" -- a genuinely empty archive, not a choice.
 */
export function useActiveUser(users) {
  const [activeId, setActiveIdState] = useState(readStored() ?? null);

  useEffect(() => {
    if (!users.length) return;
    if (users.some((user) => user.id === activeId)) return;
    const stored = readStored();
    const storedTabExists = stored !== undefined && users.some((user) => user.id === stored);
    setActiveIdState(storedTabExists ? stored : users[0].id);
  }, [users, activeId]);

  const setActiveId = (id) => {
    setActiveIdState(id);
    writeStored(id);
  };

  const activeUser = users.find((user) => user.id === activeId) ?? null;

  return [activeId, setActiveId, activeUser];
}
