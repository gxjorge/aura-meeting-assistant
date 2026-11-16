import type { MeetingCard } from '../../shared/types';
import MeetingCardItem from './MeetingCardItem';
import { SparkleIcon } from './Icons';

interface MeetingFeedProps {
  cards: MeetingCard[];
  listening: boolean;
  onCancelCard: (cardId: string) => void;
  onRemoveCard: (cardId: string) => void;
}

const STATUS_LABELS: Record<MeetingCard['status'], string> = {
  running: 'Working',
  ready: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const KIND_LABELS: Record<MeetingCard['kind'], string> = {
  answer: 'Answer',
  context: 'Context',
};

export default function MeetingFeed({ cards, listening, onCancelCard, onRemoveCard }: MeetingFeedProps) {
  if (cards.length === 0) {
    return (
      <main className="meeting-feed meeting-feed-empty">
        <div className="empty-icon">
          <SparkleIcon />
        </div>
        <h2>{listening ? 'Listening for useful context' : 'Start listening during a call'}</h2>
        <p>
          Aura follows the active profile's instructions: it surfaces context cards for what the
          profile cares about, and starts one answer agent when someone on the call explicitly says
          they need to check something.
        </p>
      </main>
    );
  }

  return (
    <main className="meeting-feed">
      {cards.map((card) => (
        <MeetingCardItem
          key={card.id}
          card={card}
          statusLabel={STATUS_LABELS[card.status]}
          kindLabel={KIND_LABELS[card.kind]}
          onCancelCard={onCancelCard}
          onRemoveCard={onRemoveCard}
        />
      ))}
    </main>
  );
}
