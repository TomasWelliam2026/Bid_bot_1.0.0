import { useState } from 'react';

/**
 * The human check queue: submissions held back until someone decides.
 *
 * Nothing here has been written to disk yet — approving is what renders the
 * PDFs and files them, so this is the last point at which a posting can be
 * dropped without leaving anything behind.
 */
export default function ReviewQueue({ records, onApprove, onReject }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  if (records.length === 0) return null;

  const act = async (id, action, run) => {
    setBusy(`${id}:${action}`);
    setError(null);
    const result = await run(id);
    setBusy(null);
    if (result && result.error) setError(`#${id} ${action} failed — ${result.error}`);
  };

  return (
    <section className="panel review">
      <div className="panel-head">
        <h2 className="panel-title">Waiting for review</h2>
        <span className="chip warn">{records.length} held</span>
      </div>
      <p className="panel-sub">
        Nothing is written until you approve. Rejecting discards the submission and keeps the disk clean.
      </p>

      {error ? <div className="note critical">{error}</div> : null}

      <ul className="queue">
        {records.map((record) => (
          <li key={record.id}>
            <div className="queue-what">
              <div className="queue-title">{record.job_title}</div>
              <div className="queue-company">{record.company}</div>
              {record.job_url ? (
                <a className="queue-url" href={record.job_url} target="_blank" rel="noreferrer">
                  {record.job_url}
                </a>
              ) : null}
            </div>
            <div className="queue-actions">
              <button
                className="btn btn-primary"
                disabled={busy !== null}
                onClick={() => act(record.id, 'approve', onApprove)}
              >
                {busy === `${record.id}:approve` ? 'Saving…' : 'Approve & save'}
              </button>
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() => act(record.id, 'reject', onReject)}
              >
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
