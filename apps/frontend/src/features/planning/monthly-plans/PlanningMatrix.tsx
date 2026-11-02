import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DateOnly } from '../../../shared/time/month';
import type { Duty } from './monthly-plan-types';
import {
  cellName,
  cellText,
  dayHeader,
  dayName,
  dayText,
  dutiesOn,
  spokenDate,
  type MatrixRow,
} from './planning-matrix';

/** What a cell activation selects: a person on a day, or the day's duties (summary row). */
export type MatrixSelection = { date: DateOnly; employeeId: string | null };

type MatrixProps = {
  caption: string;
  days: readonly DateOnly[];
  rows: readonly MatrixRow[];
  duties: readonly Duty[];
  /** The cell whose details are open in the focus panel (marked as selected). */
  selected: MatrixSelection | null;
  /** Duty open in the editor; its cells are marked. */
  editingDutyId: string | null;
  onSelect: (selection: MatrixSelection, trigger: HTMLElement) => void;
};

type Position = { row: number; col: number };

/**
 * UX A10 employee-by-day matrix as an ARIA grid (5.7 §7.3). Row 0 lists the
 * day's duties (including duties without members), rows 1..n one person each.
 * Exactly one cell is in the tab order (roving tabindex); arrow keys, Home/End
 * and Ctrl+Home/End move within the grid; Enter/Space open the focus panel.
 * Every cell's accessible name carries person, date and current state.
 */
export function PlanningMatrix({ caption, days, rows, duties, selected, editingDutyId, onSelect }: MatrixProps) {
  const captionId = useId();
  const table = useRef<HTMLTableElement>(null);
  const [active, setActive] = useState<Position>({ row: 0, col: 0 });
  const rowCount = rows.length + 1;
  // Clamped on every render: filters can shrink the grid under the active cell.
  const position = { row: Math.min(active.row, rowCount - 1), col: Math.min(active.col, days.length - 1) };
  const byDate = new Map(days.map((date) => [date, dutiesOn(duties, date)]));
  const editingKey = editingDutyId?.toLowerCase() ?? null;

  function focusCell(next: Position) {
    setActive(next);
    table.current?.querySelector<HTMLButtonElement>(`button[data-row="${next.row}"][data-col="${next.col}"]`)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const target = event.target as HTMLElement;
    if (target.dataset.row === undefined) return;
    const current = { row: Number(target.dataset.row), col: Number(target.dataset.col) };
    const lastRow = rowCount - 1;
    const lastCol = days.length - 1;
    let next: Position | null = null;
    switch (event.key) {
      case 'ArrowRight': next = { ...current, col: Math.min(lastCol, current.col + 1) }; break;
      case 'ArrowLeft': next = { ...current, col: Math.max(0, current.col - 1) }; break;
      case 'ArrowDown': next = { ...current, row: Math.min(lastRow, current.row + 1) }; break;
      case 'ArrowUp': next = { ...current, row: Math.max(0, current.row - 1) }; break;
      case 'Home': next = event.ctrlKey ? { row: 0, col: 0 } : { ...current, col: 0 }; break;
      case 'End': next = event.ctrlKey ? { row: lastRow, col: lastCol } : { ...current, col: lastCol }; break;
      default: return;
    }
    event.preventDefault();
    focusCell(next);
  }

  function cellButton(row: number, col: number, label: string, content: ReactNode, onActivate: (button: HTMLElement) => void, extra = '') {
    const isActive = position.row === row && position.col === col;
    return (
      <button
        type="button"
        className={`planning-matrix__cell${extra}`}
        data-row={row}
        data-col={col}
        tabIndex={isActive ? 0 : -1}
        aria-label={label}
        onFocus={() => setActive({ row, col })}
        onClick={(event) => onActivate(event.currentTarget)}
      >
        {content}
      </button>
    );
  }

  return (
    <>
      {/* Visible title outside the scroll frame; the caption (same text) names the grid. */}
      <p className="planning-matrix__title" aria-hidden="true">{caption}</p>
      <div className="planning-matrix__wrap">
        <table
          ref={table}
          className="planning-matrix"
          role="grid"
          aria-labelledby={captionId}
          aria-rowcount={rowCount + 1}
          aria-colcount={days.length + 1}
          onKeyDown={onKeyDown}
        >
          <caption id={captionId} className="planning-matrix__sr">{caption}</caption>
          <thead>
            <tr aria-rowindex={1}>
              <th scope="col" className="planning-matrix__corner">Person</th>
              {days.map((date) => {
                const header = dayHeader(date);
                return (
                  <th key={date} scope="col" className={header.weekend ? 'planning-matrix__weekend' : undefined}>
                    <span aria-hidden="true">
                      <span className="planning-matrix__weekday">{header.weekday}</span>
                      <span className="planning-matrix__day">{header.day}</span>
                    </span>
                    <span className="planning-matrix__sr">{spokenDate(date)}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            <tr className="planning-matrix__duties" aria-rowindex={2}>
              <th scope="row">Dienste am Tag</th>
              {days.map((date, col) => {
                const day = byDate.get(date)!;
                const isSelected = selected?.employeeId === null && selected.date === date;
                const editing = editingKey !== null
                  && Object.values(day).some((duty) => duty?.id.toLowerCase() === editingKey);
                return (
                  <td
                    key={date}
                    aria-selected={isSelected ? true : undefined}
                    className={dayHeader(date).weekend ? 'planning-matrix__weekend' : undefined}
                  >
                    {cellButton(0, col, dayName(date, day), dayText(day),
                      (button) => onSelect({ date, employeeId: null }, button),
                      `${editing ? ' planning-matrix__cell--editing' : ''}${dayText(day) === '–' ? ' planning-matrix__cell--free' : ''}`)}
                  </td>
                );
              })}
            </tr>
            {rows.map((row, index) => (
              <tr key={row.key} aria-rowindex={index + 3}>
                <th scope="row" className="planning-matrix__person">
                  <span className="planning-matrix__name">{row.name}</span>
                  {row.code && <span className="planning-matrix__code">{row.code}</span>}
                  {row.inactive && <span className="planning-matrix__flag">deaktiviert</span>}
                  {!row.assigned && row.employee && <span className="planning-matrix__flag">nicht zugeordnet</span>}
                </th>
                {days.map((date, col) => {
                  const entries = row.cells.get(date);
                  const isSelected = selected?.employeeId?.toLowerCase() === row.key && selected.date === date;
                  const unavailable = entries?.some((entry) => entry.unavailable) ?? false;
                  const lead = entries?.some((entry) => entry.member.dutyRole === 'SHIFT_LEAD') ?? false;
                  const editing = editingKey !== null && (entries?.some((entry) => entry.duty.id.toLowerCase() === editingKey) ?? false);
                  const kinds = entries?.map((entry) => entry.duty.shiftKind.toLowerCase()).join('-') ?? 'free';
                  // Visible markers repeat what the accessible name says: role (SL) and a neutral hint (!).
                  const content = (
                    <>
                      {cellText(entries)}
                      {lead && <span className="planning-matrix__mark">SL</span>}
                      {unavailable && <span className="planning-matrix__mark planning-matrix__mark--hint">!</span>}
                    </>
                  );
                  return (
                    <td key={date} aria-selected={isSelected ? true : undefined} className={dayHeader(date).weekend ? 'planning-matrix__weekend' : undefined}>
                      {cellButton(index + 1, col, cellName(row.name, date, entries), content,
                        (button) => onSelect({ date, employeeId: row.employeeId }, button),
                        ` planning-matrix__cell--${kinds}${unavailable ? ' planning-matrix__cell--conflict' : ''}${editing ? ' planning-matrix__cell--editing' : ''}`)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
