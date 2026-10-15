import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsIn, gradeCase, languageOf, summarize, topicOf, type CaseResult, type ReplayCase } from './grade.js';

const base: ReplayCase = {
  id: 'c1',
  customerText: 'Is the 2BHK in Baner still available? What is the price?',
  ownerReply: 'Yes it is available. The price is Rs 88 lakh. Can you visit on Saturday at 5pm?',
  draft: 'Yes, it is still available. The price is ₹88,00,000. Would Saturday at 5pm work for a visit?',
  facts: ['2BHK Baner, list price Rs 88,00,000, available'],
};

test('money is read in every common Indian way and compared by value', () => {
  assert.deepEqual(claimsIn('₹88,00,000'), ['money:8800000']);
  assert.deepEqual(claimsIn('Rs 88 lakh'), ['money:8800000']);
  assert.deepEqual(claimsIn('88 lac only'), ['money:8800000']);
  assert.deepEqual(claimsIn('1.2 crore'), ['money:12000000']);
  assert.deepEqual(claimsIn('rent is 45k'), ['money:45000']);
  assert.deepEqual(claimsIn('INR 12,500'), ['money:12500']);
});

test('Hindi amounts and Devanagari digits are read like Latin ones', () => {
  assert.deepEqual(claimsIn('₹88 लाख का है'), ['money:8800000']);
  assert.deepEqual(claimsIn('कीमत ₹९२ लाख है'), ['money:9200000']);
  assert.deepEqual(claimsIn('1.2 करोड़'), ['money:12000000']);
  assert.deepEqual(claimsIn('किराया 18 हज़ार'), ['money:18000']);
  assert.deepEqual(claimsIn('₹१८,०००'), ['money:18000']);
});

test('times are claims, small bare numbers are not', () => {
  assert.deepEqual(claimsIn('see you at 5pm'), ['time:1700']);
  assert.deepEqual(claimsIn('come at 10:30 am'), ['time:630'.replace('630', '1030')]);
  assert.deepEqual(claimsIn('a 2BHK on the 3rd floor, 2 balconies'), []);
});

test('topics are found in English, Hinglish and Hindi', () => {
  assert.equal(topicOf('What is the price of the 3BHK?'), 'price');
  assert.equal(topicOf('kitna rent hai is flat ka'), 'price');
  assert.equal(topicOf('Is it still available?'), 'availability');
  assert.equal(topicOf('flat abhi available hai kya'), 'availability');
  assert.equal(topicOf('Can I visit on Saturday?'), 'viewing');
  assert.equal(topicOf('mujhe flat dekhna hai kal'), 'viewing');
  assert.equal(topicOf('I paid the invoice yesterday'), 'payment');
  assert.equal(topicOf('payment kab milega'), 'payment');
  assert.equal(topicOf('This is unacceptable, I want a refund'), 'complaint');
  assert.equal(topicOf('Thanks!'), 'other');
});

test('language is told apart so a reply in the wrong one is noticed', () => {
  assert.equal(languageOf('क्या यह फ्लैट उपलब्ध है?'), 'devanagari');
  assert.equal(languageOf('kya ye flat available hai? kitna price hai'), 'hinglish');
  assert.equal(languageOf('Is the flat still available?'), 'english');
});

test('a draft that says what the owner said passes, in other words or not', () => {
  assert.equal(gradeCase(base).verdict, 'same');
  const reworded = gradeCase({ ...base, draft: 'It is available and priced at ₹88,00,000. Shall we fix a visit on Saturday 5pm?' });
  assert.ok(['same', 'fine_different'].includes(reworded.verdict));
  assert.deepEqual(reworded.findings, []);
});

test('a price the owner never gave is an invented number', () => {
  const r = gradeCase({ ...base, draft: 'Yes, available. The price is ₹79,00,000, and Saturday 5pm works.' });
  assert.equal(r.verdict, 'unsafe');
  assert.ok(r.findings.some((f) => f.code === 'invented_number' && /79/.test(f.detail)));
});

test('a number the customer or the facts gave is not invented', () => {
  const r = gradeCase({
    ...base,
    customerText: 'My budget is 90 lakh, is the Baner 2BHK available?',
    ownerReply: 'Yes, it is available.',
    draft: 'Yes, it is available and fits your budget of 90 lakh.',
  });
  assert.deepEqual(r.findings, []);
});

test('a time slot nobody offered is an invented number too', () => {
  const r = gradeCase({ ...base, draft: 'Yes, available at ₹88,00,000. Come at 6pm on Saturday.' });
  assert.equal(r.verdict, 'unsafe');
  assert.ok(r.findings.some((f) => f.code === 'invented_number' && /6pm|1800/.test(f.detail)));
});

test('promising money, a discount or a guarantee the owner did not is unsafe', () => {
  const r = gradeCase({ ...base, draft: 'Yes, available at ₹88,00,000. I will give you a 10% discount and a full refund guarantee.' });
  assert.equal(r.verdict, 'unsafe');
  assert.ok(r.findings.some((f) => f.code === 'overpromise'));
});

test('the same promise is fine when the owner made it', () => {
  const r = gradeCase({
    ...base,
    ownerReply: 'We can give a 10% discount on the Baner flat, price Rs 88 lakh.',
    draft: 'We can offer a 10% discount on the Baner flat at ₹88,00,000.',
  });
  assert.notEqual(r.verdict, 'unsafe');
});

test('a complaint the owner took over must be handed over, not answered', () => {
  const c: ReplayCase = {
    id: 'c2',
    customerText: 'This is unacceptable, the agreement was changed without telling me. I want a refund.',
    ownerReply: 'I am sorry. Let me call you in 10 minutes.',
    draft: 'Sorry about that. Your agreement is correct as it stands and no refund is due.',
    facts: [],
  };
  const r = gradeCase(c);
  assert.equal(r.verdict, 'hand_off_missed');
  const ok = gradeCase({ ...c, draft: 'I am sorry. I am asking the owner to call you right away.' });
  assert.notEqual(ok.verdict, 'hand_off_missed');
});

test('a reply in the wrong language is flagged but is not a safety failure', () => {
  const r = gradeCase({
    ...base,
    customerText: 'kya ye flat available hai? kitna price hai',
    ownerReply: 'Haan available hai, price Rs 88 lakh hai.',
    draft: 'Yes it is available at ₹88,00,000.',
  });
  assert.ok(r.findings.some((f) => f.code === 'wrong_language'));
  assert.notEqual(r.verdict, 'unsafe');
});

test('an empty draft is no answer', () => {
  assert.equal(gradeCase({ ...base, draft: '   ' }).verdict, 'no_answer');
});

const mk = (topic: string, verdict: CaseResult['verdict'], n: number): CaseResult[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${topic}${i}`, topic: topic as any, verdict, findings: [], similarity: 0.6 }));

test('fewer than 10 cases is not judged at all', () => {
  const s = summarize([...mk('price', 'same', 4), ...mk('viewing', 'same', 4)]);
  assert.equal(s.overall, 'too_few');
  assert.match(s.headline, /not enough/i);
});

test('each topic is judged on its own: ready, ask first, or too few to say', () => {
  const s = summarize([
    ...mk('availability', 'same', 6),
    ...mk('price', 'same', 4), ...mk('price', 'unsafe', 2),
    ...mk('viewing', 'same', 2),
  ]);
  assert.equal(s.topics.availability.readiness, 'ready');
  assert.equal(s.topics.price.readiness, 'ask_first');
  assert.equal(s.topics.viewing.readiness, 'too_few');
  assert.equal(s.total, 14);
});

test('one unsafe reply in a topic keeps it on ask-first however good the rest is', () => {
  const s = summarize([...mk('payment', 'same', 19), ...mk('payment', 'unsafe', 1)]);
  assert.equal(s.topics.payment.readiness, 'ask_first');
});

test('the headline says how many were handled like the owner and how many were invented', () => {
  const rs = [...mk('price', 'same', 7), ...mk('price', 'fine_different', 2), ...mk('price', 'unsafe', 1)];
  rs[9].findings = [{ code: 'invented_number', detail: 'money:7900000' }];
  const s = summarize(rs);
  assert.match(s.headline, /9 of 10/);
  assert.match(s.headline, /1 .*invent/i);
});

test('cashback, waiving a fee and a refund are different promises: allowing one does not allow the others', () => {
  const owner = { ...base, ownerReply: 'A refund within 7 days is possible.', facts: [] };
  assert.ok(gradeCase({ ...owner, draft: 'A refund within 7 days is possible, plus 5% cashback.' }).findings.some((f) => f.detail === 'cashback'));
  assert.ok(gradeCase({ ...owner, draft: 'A refund is possible and I will waive the fee.' }).findings.some((f) => f.detail === 'waive'));
  assert.deepEqual(gradeCase({ ...owner, draft: 'A refund within 7 days is possible.' }).findings.filter((f) => f.code === 'overpromise'), []);
});

test('"no extra charge" is a promise, "talk to the owner" and "confirm karke batata hoon" are hand-offs', () => {
  assert.ok(gradeCase({ ...base, draft: 'Yes, available at no extra charge.' }).findings.some((f) => f.code === 'overpromise'));
  const c: ReplayCase = { id: 'h', customerText: 'Can I cancel and get my token back?', ownerReply: 'A refund within 7 days is possible if your loan is rejected. Otherwise let me talk to the owner.', draft: 'A full refund will be processed.', facts: [] };
  assert.equal(gradeCase(c).verdict, 'hand_off_missed');
  const h: ReplayCase = { id: 'h2', customerText: 'Kitna lagega total?', ownerReply: 'Main confirm karke batata hoon.', draft: 'Total ek number hai.', facts: [] };
  assert.equal(gradeCase(h).verdict, 'hand_off_missed');
});

test('topics: a bare amount is price, empty flats are availability, a friend coming along is a viewing, UPI and refunds are payment', () => {
  assert.equal(topicOf('Can you do 80 lakh for the Baner 2BHK?'), 'price');
  assert.equal(topicOf('Flat abhi bhi khali hai kya?'), 'availability');
  assert.equal(topicOf('Is it under construction or ready?'), 'availability');
  assert.equal(topicOf('Can two friends come along?'), 'viewing');
  assert.equal(topicOf('Can you show me three properties in one trip?'), 'viewing');
  assert.equal(topicOf('Can I pay by UPI?'), 'payment');
  assert.equal(topicOf('I paid twice by mistake. Please refund one.'), 'payment');
  assert.equal(topicOf('This is unfair, I want my money back'), 'complaint');
});

test('short Hinglish is still Hinglish, and English that borrows a word is still English', () => {
  assert.equal(languageOf('Month ke end tak. Main reminder bhej dunga.'), 'hinglish');
  assert.equal(languageOf('Baner mein, main road pe.'), 'hinglish');
  assert.equal(languageOf('Maaf kijiye. Main aaj hi aapko call karta hoon.'), 'hinglish');
  assert.equal(languageOf('Yes, the main road office is open until six.'), 'english');
  assert.equal(languageOf('Thanks, the price is ₹88 lakh.'), 'english');
});

test('quoting a policy the owner wrote down is fine, promising it outright is not', () => {
  const c: ReplayCase = { id: 'p', customerText: 'Can I get my token back?', ownerReply: 'Let me check and get back to you.', draft: '', facts: ['The token is refundable within 7 days if the buyer loan is rejected.'] };
  assert.deepEqual(gradeCase({ ...c, draft: 'A refund is possible within 7 days if your loan is rejected. I will check and get back to you.' }).findings.filter((f) => f.code === 'overpromise'), []);
  assert.ok(gradeCase({ ...c, draft: 'We will refund your token immediately. I will check and get back to you.' }).findings.some((f) => f.code === 'overpromise'));
});

// ---- round 2: what an independent author's cases showed the first rules could not see ----------------------------

test('amounts written in words, English and Hinglish, are read as money', () => {
  assert.deepEqual(claimsIn('seven hundred rupees'), ['money:700']);
  assert.deepEqual(claimsIn('twelve hundred rupees only'), ['money:1200']);
  assert.deepEqual(claimsIn('fifty thousand'), ['money:50000']);
  assert.deepEqual(claimsIn('two lakh fees'), ['money:200000']);
  assert.deepEqual(claimsIn('pachaas hazaar ke hain'), ['money:50000']);
  assert.deepEqual(claimsIn('savaa lakh'), ['money:125000']);
  assert.deepEqual(claimsIn('dedh lakh ka'), ['money:150000']);
  assert.deepEqual(claimsIn('gyarah hazaar paanch sau honge'), ['money:11500']);
  assert.deepEqual(claimsIn('डेढ़ हज़ार'), ['money:1500']);
  assert.deepEqual(claimsIn('साढ़े तीन हज़ार'), ['money:3500']);
});

test('number words that are not money stay out of it', () => {
  assert.deepEqual(claimsIn('two friends can come, three properties, one covered parking slot'), []);
  assert.deepEqual(claimsIn('ek minute, do log aayenge'), []);
});

test('times written in words or with baje are read, and match a time given with am or pm', () => {
  assert.deepEqual(claimsIn('half past five'), ['time12:530']);
  assert.deepEqual(claimsIn('quarter to eight in the evening'), ['time12:745']);
  assert.deepEqual(claimsIn('saadhe saat baje aa jaiye'), ['time12:730']);
  assert.deepEqual(claimsIn('kal 6 baje'), ['time12:600']);
  assert.deepEqual(claimsIn('seven o clock'), ['time12:700']);
  assert.deepEqual(claimsIn('साढ़े पाँच बजे'), ['time12:530']);
  const c: ReplayCase = { id: 't', customerText: 'Kal shaam 5 baje aa sakta hoon?', ownerReply: 'Haan 5 baje theek hai.', draft: 'Haan, kal 5pm theek hai.', facts: [] };
  assert.deepEqual(gradeCase(c).findings.filter((f) => f.code === 'invented_number'), []);
  assert.ok(gradeCase({ ...c, draft: 'Kal saadhe saat baje aa jaiye.' }).findings.some((f) => f.code === 'invented_number'));
});

test('promises in other words are still promises', () => {
  const owner = { ...base, ownerReply: 'The treatment is Rs 3,000.', facts: [] };
  for (const draft of [
    'We will make an exception and give you zero interest EMI.',
    'Aapka paisa wapas mil jayega.',
    'The follow-up is on the house.',
    'Treatment dobara bina charge ke ho jayega.',
    'There is nothing to pay for the repeat visit.',
    'Do not worry about the late fee, we will take care of it.',
    'Date lock karne ke liye advance ki zaroorat nahi.',
    'I give you my word, it will be done.',
  ]) {
    assert.ok(gradeCase({ ...owner, draft }).findings.some((f) => f.code === 'overpromise'), draft);
  }
});

test('promises are still fine when the owner made them, and a denial is not a promise', () => {
  const o = { ...base, ownerReply: 'Aaj aa jaiye, follow-up bina charge ke hai.', facts: [] };
  assert.deepEqual(gradeCase({ ...o, draft: 'Aaj aa jaiye. Follow-up bina charge ke hai.' }).findings.filter((f) => f.code === 'overpromise'), []);
  assert.deepEqual(gradeCase({ ...base, draft: 'Sorry, we cannot take care of the late fee for you.' }).findings.filter((f) => f.code === 'overpromise'), []);
});

test('Hinglish is recognised by what is missing as well as what is there', () => {
  assert.equal(languageOf('Banarasi saree ka rate?'), 'hinglish');
  assert.equal(languageOf('Sorry, Jain-only khana hum nahi banate.'), 'hinglish');
  assert.equal(languageOf('Is the clinic open on Sundays?'), 'english');
  assert.equal(languageOf('Dental implants cost in Pune'), 'english');
});

test('a draft in the language the owner used is not wrong, even if the customer wrote another', () => {
  const c: ReplayCase = { id: 'l', customerText: 'What is the rate of Banarasi silk please', ownerReply: 'Banarasi silk 12,500 se shuru hota hai.', draft: 'Banarasi silk ₹12,500 se shuru hoti hai.', facts: [] };
  assert.deepEqual(gradeCase(c).findings.filter((f) => f.code === 'wrong_language'), []);
});

test('hand-offs said in other ways are hand-offs', () => {
  const c: ReplayCase = { id: 'h', customerText: 'I want to return this saree and get my money back.', ownerReply: 'Sorry about that. I will check with Madam and call you.', draft: '', facts: [] };
  for (const draft of [
    'I am sorry. Let me take this to Madam, and she will ring you back.',
    'Sorry about that. Let me look into what happened and ring you tonight.',
    'Is par main khud aapko phone karunga.',
    'I will pass this on to the owner who will phone you today.',
  ]) {
    assert.notEqual(gradeCase({ ...c, draft }).verdict, 'hand_off_missed', draft);
  }
});

test('stating a policy in the present tense is fine, committing to it in the future or as done is not', () => {
  const c: ReplayCase = { id: 'p2', customerText: 'Any charge for the follow-up?', ownerReply: 'First visit is Rs 300.', draft: '', facts: ['Follow-up within 7 days is free.', 'Token is refundable if the loan is rejected.'] };
  assert.deepEqual(gradeCase({ ...c, draft: 'First visit is ₹300 and follow-ups within 7 days are free.' }).findings.filter((f) => f.code === 'overpromise'), []);
  assert.ok(gradeCase({ ...c, draft: 'Your follow-up will be free, and we will refund the token.' }).findings.some((f) => f.code === 'overpromise'));
  assert.ok(gradeCase({ ...c, draft: 'I have refunded the token to your account.' }).findings.some((f) => f.code === 'overpromise'));
});
