/**
 * Поле ввода чисел: числа-фишки вместо строки.
 *
 * Зачем отдельный компонент. Раньше здесь был обычный input с
 * inputmode="numeric" и подсказкой «7 23». На телефоне такой input открывает
 * цифровую клавиатуру, а на ней нет ни пробела, ни запятой — ввести второе
 * число физически невозможно. Менять inputmode на текстовый — значит открывать
 * полную клавиатуру ради двух цифр.
 *
 * Поэтому число не пишется в строку, а превращается в фишку. Разделитель
 * больше не нужен: поле само понимает, когда число закончилось.
 *
 *   • цифра, после которой число уже не может продолжиться (5 при поле 1–45,
 *     потому что 50 вне диапазона), становится фишкой сразу;
 *   • вторая цифра завершает число всегда;
 *   • Enter, потеря фокуса и кнопка «+» тоже завершают;
 *   • пробел, запятая и точка — если человек всё-таки на полной клавиатуре;
 *   • Backspace на пустом поле снимает последнюю фишку.
 */

export class NumberField {
  /**
   * @param {HTMLElement} host   куда встроить поле
   * @param {object} options     { pool, placeholder, onChange }
   */
  constructor(host, { pool, placeholder = '', onChange = () => {} } = {}) {
    this.host = host;
    this.pool = pool;
    this.onChange = onChange;
    this.values = [];
    this.placeholderText = placeholder;

    host.replaceChildren();
    host.className = 'numfield';
    host.addEventListener('mousedown', (event) => {
      // Клик по пустому месту поля — это намерение писать, а не выделять.
      if (event.target === host) {
        event.preventDefault();
        this.input.focus();
      }
    });

    this.chips = document.createElement('span');
    this.chips.className = 'numfield__chips';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'numfield__input';
    this.input.inputMode = 'numeric';
    this.input.autocomplete = 'off';
    this.input.enterKeyHint = 'done';
    this.input.placeholder = placeholder;
    this.input.setAttribute('aria-label', placeholder || 'Числа');

    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.input.addEventListener('blur', () => this.commit());

    host.append(this.chips, this.input);
    this.render();
  }

  get maxFirstDigit() {
    return Math.floor(this.pool / 10);
  }

  onInput() {
    // Разделители с полной клавиатуры завершают число, а не попадают в него.
    if (/[^\d]/.test(this.input.value)) {
      this.input.value = this.input.value.replace(/[^\d]/g, '');
      this.commit();
      return;
    }
    const raw = this.input.value;
    if (!raw) return;

    // Однозначное число, которое уже нельзя продолжить: 5 при поле до 45
    // дало бы 50 — вне диапазона, значит человек имел в виду пятёрку.
    if (raw.length === 1 && Number(raw) > this.maxFirstDigit) {
      this.commit();
      return;
    }
    if (raw.length >= 2) this.commit();
  }

  onKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commit();
      return;
    }
    if (event.key === 'Backspace' && !this.input.value && this.values.length) {
      event.preventDefault();
      this.values.pop();
      this.render();
      this.onChange(this.value());
    }
  }

  /** Превращает набранное в фишку. Невалидное подсвечиваем и не теряем. */
  commit() {
    const raw = this.input.value.replace(/[^\d]/g, '');
    this.input.value = '';
    if (!raw) {
      this.host.classList.remove('is-bad');
      return;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > this.pool) {
      this.flashBad();
      return;
    }
    if (!this.values.includes(n)) {
      this.values.push(n);
      this.values.sort((a, b) => a - b);
      this.render();
      this.onChange(this.value());
    }
  }

  flashBad() {
    this.host.classList.add('is-bad');
    setTimeout(() => this.host.classList.remove('is-bad'), 600);
  }

  render() {
    this.chips.replaceChildren();
    this.values.forEach((n) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'numchip';
      chip.textContent = String(n);
      chip.setAttribute('aria-label', `Убрать ${n}`);
      chip.addEventListener('click', () => {
        this.values = this.values.filter((v) => v !== n);
        this.render();
        this.onChange(this.value());
        this.input.focus();
      });
      this.chips.append(chip);
    });
    this.host.classList.toggle('is-empty', this.values.length === 0);
    // Плейсхолдер нужен, только пока фишек нет: рядом с ними он мешает.
    this.input.placeholder = this.values.length ? '' : this.placeholderText;
  }

  set placeholder(text) {
    this.placeholderText = text;
    this.input.placeholder = this.values.length ? '' : text;
  }

  /** Итоговые числа. Незавершённый ввод учитывается — его не потеряли. */
  value() {
    const pending = Number(this.input.value.replace(/[^\d]/g, ''));
    const all = [...this.values];
    if (pending >= 1 && pending <= this.pool && !all.includes(pending)) all.push(pending);
    return all.sort((a, b) => a - b);
  }

  clear() {
    this.values = [];
    this.input.value = '';
    this.render();
  }

  setPool(pool) {
    this.pool = pool;
    this.values = this.values.filter((n) => n <= pool);
    this.render();
  }
}
