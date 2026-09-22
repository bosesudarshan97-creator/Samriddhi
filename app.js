const STORAGE_KEY = 'habit-tracker-habits';

const habitForm = document.querySelector('#habit-form');
const habitNameInput = document.querySelector('#habit-name');
const habitList = document.querySelector('#habit-list');
const emptyState = document.querySelector('#empty-state');
const habitCount = document.querySelector('#habit-count');
const todayLabel = document.querySelector('#today-label');
const habitCardTemplate = document.querySelector('#habit-card-template');

let habits = loadHabits();

function getDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function loadHabits() {
  try {
    const savedHabits = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!Array.isArray(savedHabits)) {
      return [];
    }

    return savedHabits.filter((habit) => (
      habit && typeof habit.id === 'string' && typeof habit.name === 'string' && Array.isArray(habit.completedDates)
    ));
  } catch {
    return [];
  }
}

function saveHabits() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(habits));
}

function getCurrentStreak(completedDates) {
  const completed = new Set(completedDates);
  const currentDate = new Date();
  let streak = 0;

  while (completed.has(getDateKey(currentDate))) {
    streak += 1;
    currentDate.setDate(currentDate.getDate() - 1);
  }

  return streak;
}

function renderHabits() {
  habitList.replaceChildren();
  emptyState.hidden = habits.length > 0;
  habitCount.textContent = `${habits.length} habit${habits.length === 1 ? '' : 's'}`;

  habits.forEach((habit) => {
    const card = habitCardTemplate.content.cloneNode(true);
    const cardElement = card.querySelector('.habit-card');
    const completeButton = card.querySelector('.complete-button');
    const todayKey = getDateKey();
    const isComplete = habit.completedDates.includes(todayKey);

    card.querySelector('.habit-name').textContent = habit.name;
    card.querySelector('.streak-number').textContent = getCurrentStreak(habit.completedDates);
    completeButton.textContent = isComplete ? 'Completed today' : 'Mark done today';
    completeButton.classList.toggle('is-complete', isComplete);
    completeButton.setAttribute('aria-pressed', String(isComplete));

    completeButton.addEventListener('click', () => toggleToday(habit.id));
    card.querySelector('.delete-button').addEventListener('click', () => deleteHabit(habit.id));
    cardElement.dataset.habitId = habit.id;
    habitList.append(card);
  });
}

function addHabit(name) {
  habits.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
    completedDates: []
  });
  saveHabits();
  renderHabits();
}

function toggleToday(habitId) {
  const habit = habits.find((item) => item.id === habitId);
  if (!habit) {
    return;
  }

  const todayKey = getDateKey();
  const dateIndex = habit.completedDates.indexOf(todayKey);

  if (dateIndex === -1) {
    habit.completedDates.push(todayKey);
  } else {
    habit.completedDates.splice(dateIndex, 1);
  }

  saveHabits();
  renderHabits();
}

function deleteHabit(habitId) {
  habits = habits.filter((habit) => habit.id !== habitId);
  saveHabits();
  renderHabits();
}

habitForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = habitNameInput.value.trim();

  if (!name) {
    return;
  }

  addHabit(name);
  habitForm.reset();
  habitNameInput.focus();
});

todayLabel.textContent = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric'
}).format(new Date());

renderHabits();
