import { useEffect, useId, useRef, useState } from 'react';
import { CUSTOM_OPTION_LABEL, SKIPPED_ANSWER, type QuestionAnswer, type QuestionRequest } from '../questions';

/**
 * One clarifying question at a time, above the composer.
 * The first suggestion is marked recommended and is not pre-selected.
 * The last radio is always a custom message.
 */
export function QuestionCard({
  request,
  onSubmit
}: {
  request: QuestionRequest;
  onSubmit: (answers: QuestionAnswer[]) => void;
}): JSX.Element {
  const [index, setIndex] = useState(0);
  const [selection, setSelection] = useState<number | 'custom' | undefined>(undefined);
  const [custom, setCustom] = useState('');
  const [answers, setAnswers] = useState<QuestionAnswer[]>([]);
  const cardRef = useRef<HTMLElement>(null);
  const customId = useId();
  const question = request.questions[index] ?? request.questions[0];
  const total = request.questions.length;
  const last = index >= total - 1;
  const customText = custom.trim();
  const canContinue =
    selection === 'custom' ? customText.length > 0 : typeof selection === 'number' && selection < (question?.options.length ?? 0);

  useEffect(() => {
    cardRef.current?.focus();
  }, [request.id, index]);

  if (!question) {
    return <></>;
  }

  const choose = (next: number | 'custom'): void => {
    setSelection(next);
  };

  const commit = (text: string): void => {
    const nextAnswers = [...answers, { questionId: question.id, text }];
    if (last) {
      onSubmit(nextAnswers);
      return;
    }
    setAnswers(nextAnswers);
    setIndex((value) => value + 1);
    setSelection(undefined);
    setCustom('');
  };

  const confirm = (): void => {
    if (!canContinue) {
      return;
    }
    if (selection === 'custom') {
      commit(customText);
      return;
    }
    const label = question.options[selection ?? -1];
    if (label) {
      commit(label);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const inField = event.target instanceof HTMLTextAreaElement;
    if (!inField && /^[1-9]$/.test(event.key)) {
      const choice = Number(event.key) - 1;
      event.preventDefault();
      if (choice < question.options.length) {
        choose(choice);
      } else if (choice === question.options.length) {
        choose('custom');
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      confirm();
    }
  };

  return (
    <section
      className="question-card"
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-label="Question from the agent"
      onKeyDown={onKeyDown}
    >
      <header className="question-card__head">
        <span className="question-card__title">Question</span>
        {total > 1 ? (
          <span className="question-card__count">
            {index + 1} of {total}
          </span>
        ) : null}
      </header>
      {question.header ? <p className="question-card__header">{question.header}</p> : null}
      <p className="question-card__prompt" id={`${customId}-prompt`}>
        {question.prompt}
      </p>
      <div className="question-card__options" role="radiogroup" aria-labelledby={`${customId}-prompt`}>
        {question.options.map((option, optionIndex) => {
          const optionId = `${customId}-option-${optionIndex}`;
          return (
            <label className="question-card__option" key={option} htmlFor={optionId}>
              <input
                id={optionId}
                type="radio"
                name={`${customId}-choice`}
                checked={selection === optionIndex}
                onChange={() => choose(optionIndex)}
              />
              <span className="question-card__option-text">{option}</span>
              {optionIndex === 0 ? <span className="question-card__chip">Recommended</span> : null}
            </label>
          );
        })}
        <label className="question-card__option" htmlFor={`${customId}-custom`}>
          <input
            id={`${customId}-custom`}
            type="radio"
            name={`${customId}-choice`}
            checked={selection === 'custom'}
            onChange={() => choose('custom')}
          />
          <span className="question-card__option-text">{CUSTOM_OPTION_LABEL}</span>
        </label>
      </div>
      {selection === 'custom' ? (
        <textarea
          className="question-card__custom"
          value={custom}
          rows={2}
          placeholder="Type your own answer"
          aria-label="Your own answer"
          onChange={(event) => setCustom(event.target.value)}
        />
      ) : null}
      <div className="question-card__actions">
        <button className="question-card__skip" type="button" onClick={() => commit(SKIPPED_ANSWER)}>
          Skip
        </button>
        <button className="question-card__continue" type="button" disabled={!canContinue} onClick={confirm}>
          {last ? 'Send' : 'Continue'}
        </button>
      </div>
    </section>
  );
}
