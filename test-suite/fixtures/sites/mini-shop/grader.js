window.MiniShopGrader = {
  validate(task, state, products, run, seed = 0) {
    let bad = [];
    const rubric = {};
    if (task === 'mini-shop-red-second-cheapest') {
      const reds = products.filter(p => p.color === 'red').sort((a,b)=>a.price-b.price);
      const target = reds[1];
      rubric.addedTarget = state.cart.includes(target.id);
      rubric.noWrongItems = state.cart.every(id => id === target.id);
      rubric.checkedOut = /^MS-\d{4}$/.test(state.orderId || '');
      if (!rubric.addedTarget) bad.push(`cart missing second-cheapest red item ${target.name}`);
      const wrong = state.cart.filter(id => id !== target.id);
      if (wrong.length) bad.push(`cart contains wrong product(s): ${wrong.join(',')}`);
      if (!rubric.checkedOut) bad.push('missing checkout order id');
    } else bad.push(`unknown task ${task}`);
    const passed = bad.length === 0;
    return { reward: passed ? 1 : 0, done: passed, message: passed ? 'all deterministic mini-shop checks passed' : bad.join('; '), info: { task, run, seed, rubric, bad, state } };
  },
  grade(task, state, products, run, seed = 0) {
    const validation = this.validate(task, state, products, run, seed);
    const verdict = validation.done ? 'PASS' : 'PENDING';
    window.__taskId = task;
    window.__taskVerdict = verdict;
    window.__taskReason = validation.done ? [validation.message] : validation.info.bad;
    window.__taskValidation = validation;
    try { localStorage.setItem(`pi-chrome-task:${task}:${run}`, JSON.stringify({ id: task, run, seed, verdict, reason: window.__taskReason, validation, state, ts: Date.now() })); } catch {}
    return validation;
  }
};
