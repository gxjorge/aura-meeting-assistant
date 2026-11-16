import { useLayoutEffect, useRef, useState } from 'react';
import type { MeetingCard } from '../../shared/types';
import AnswerMarkdown from './AnswerMarkdown';
import { CloseIcon, ExternalLinkIcon } from './Icons';

interface MeetingCardItemProps {
  card: MeetingCard;
  statusLabel: string;
  kindLabel: string;
  onCancelCard: (cardId: string) => void;
  onRemoveCard: (cardId: string) => void;
}

// A collapsed card must stay short enough that two of them fit the feed viewport,
// otherwise one long answer hides every card behind it.
const OVERFLOW_SLACK_PX = 8;

export default function MeetingCardItem({
  card,
  statusLabel,
  kindLabel,
  onCancelCard,
  onRemoveCard,
}: MeetingCardItemProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // The clamp is the measuring stick: an unconstrained div always reports
  // scrollHeight === clientHeight, so the card must already be clamped for the
  // overflow test to mean anything. Skip measuring while expanded, where the
  // clamp is gone and "Show less" would otherwise disappear under the user.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || expanded) return;
    setOverflowing(element.scrollHeight - element.clientHeight > OVERFLOW_SLACK_PX);
  }, [card.body, card.docs, expanded]);

  const clamped = !expanded;

  return (
    <article className={`meeting-card meeting-card-${card.kind} status-${card.status}`}>
      {card.status === 'running' && <span className="meeting-card-progress" aria-hidden="true" />}
      <div className="meeting-card-header">
        <span className="meeting-card-kind">{kindLabel}</span>
        <span className="meeting-card-status">{statusLabel}</span>
        <button
          className="card-remove icon-button"
          title="Dismiss card"
          aria-label={`Dismiss card: ${card.title}`}
          onClick={() => {
            window.aura.sendMeetingCardSignal(card.id, 'dismissed');
            onRemoveCard(card.id);
          }}
        >
          <CloseIcon />
        </button>
      </div>
      <h2>{card.title}</h2>
      <div
        ref={contentRef}
        className={`meeting-card-content${clamped ? ' is-clamped' : ''}${
          overflowing ? ' is-overflowing' : ''
        }`}
      >
        {card.body && <AnswerMarkdown markdown={card.body} />}
        {card.docs && card.docs.length > 0 && (
          <div className="learn-doc-list">
            {card.docs.map((doc) => (
              <a
                key={doc.url}
                className="learn-doc-link"
                href={doc.url}
                onClick={(event) => {
                  event.preventDefault();
                  window.aura.sendMeetingCardSignal(card.id, 'link_opened');
                  window.aura.openExternalUrl(doc.url);
                }}
              >
                <span className="learn-doc-title">
                  {doc.title}
                  <ExternalLinkIcon className="learn-doc-icon" />
                </span>
                {doc.description && <span className="learn-doc-description">{doc.description}</span>}
              </a>
            ))}
          </div>
        )}
      </div>
      {overflowing && (
        <button
          className="card-expand"
          aria-expanded={expanded}
          onClick={() => {
            if (!expanded) window.aura.sendMeetingCardSignal(card.id, 'opened');
            setExpanded((value) => !value);
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      <div className="meeting-card-footer">
        <details
          className="source-text"
          onToggle={(event) => {
            if (event.currentTarget.open) window.aura.sendMeetingCardSignal(card.id, 'opened');
          }}
        >
          <summary>Why this surfaced</summary>
          <p>{card.sourceText}</p>
        </details>
        {card.status === 'running' && (
          <button
            className="card-cancel"
            onClick={() => {
              window.aura.sendMeetingCardSignal(card.id, 'cancelled');
              onCancelCard(card.id);
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </article>
  );
}
