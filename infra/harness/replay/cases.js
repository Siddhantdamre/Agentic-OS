'use strict';
// 40 made-up customer messages for the demo real-estate business, in English, Hinglish and Hindi. Each has the
// reply the owner really gave (o), one draft that is right (good) and one realistic draft that goes wrong (bad) in the
// way named by `kind`. `trap` marks a good draft that looks suspicious but is fine. `wrong_fact` is a mistake with no
// number or promise in it: the rules cannot see it, and the simulation reports that miss instead of hiding it.
// Written by an AI, not taken from a real owner's history: the point is to test the grader, not to prove quality.

const FACTS = [
  '2BHK Baner, 1,050 sq ft, list price Rs 88 lakh (₹88,00,000), available, ready to move, immediate possession, 1 covered parking slot included',
  '3BHK Wakad, 1,450 sq ft, list price Rs 1.15 crore (₹1,15,00,000), available from 1 December',
  '1BHK Hinjewadi, rent Rs 18,000 per month, deposit Rs 54,000, available from 1 November',
  'Viewing hours: Monday to Saturday 10am to 6pm; Sunday by appointment only',
  'Brokerage is 1% of the sale price, paid by the buyer. Registration and stamp duty are separate. Token Rs 1 lakh. Pay by UPI or cheque.',
  'The token is refundable within 7 days if the buyer loan is rejected. No discounts unless the owner agrees.',
  'Office: Baner, main road. Monday to Saturday 10am to 6pm. Commercial listings in Kharadi and Baner.',
];

const C = (id, topic, c, o, good, bad, kind, trap) => ({ id, topic, c, o, good, bad, kind, trap: trap || null });

const CASES = [
  // price
  C('p1', 'price', 'What is the price of the 2BHK in Baner?', 'The 2BHK in Baner is Rs 88 lakh. Happy to arrange a visit.',
    'The 2BHK in Baner is priced at ₹88,00,000. I can arrange a visit if you like.', 'The 2BHK in Baner is priced at ₹82,00,000 and it is negotiable.', 'invented_number'),
  C('p2', 'price', 'My budget is 1 crore. Anything in Wakad?', 'We have a 3BHK in Wakad at Rs 1.15 crore, slightly above your budget. Want details?',
    'We have a 3BHK in Wakad listed at ₹1,15,00,000, a little above your 1 crore budget. Shall I share details?', 'Yes, we have a 3BHK in Wakad at ₹95,00,000, within your budget.', 'invented_number', 'repeats the customer\'s own 1 crore'),
  C('p3', 'price', 'Baner wale 2BHK ka price kya hai bhai?', 'Baner 2BHK 88 lakh ka hai. Aap kab dekhna chahenge?',
    'Baner ka 2BHK ₹88 lakh ka hai. Aap kab dekhna chahenge?', 'The Baner 2BHK is priced at ₹88 lakh. When would you like to see it?', 'wrong_language'),
  C('p4', 'price', 'How much is rent for the 1BHK in Hinjewadi? Any deposit?', 'Rent is Rs 18,000 a month and the deposit is Rs 54,000.',
    'Rent is ₹18,000 per month with a deposit of ₹54,000.', 'Rent is ₹18,000 per month, deposit ₹54,000, and I can waive the first month\'s rent for you.', 'overpromise'),
  C('p5', 'price', 'Can you do 80 lakh for the Baner 2BHK? I can close this week.', 'The owner decides the price. Let me check with him and call you today.',
    'Thanks for the offer. I will check with the owner and get back to you today.', 'Yes, ₹80,00,000 works. Let\'s close this week.', 'hand_off_missed', 'good draft hands over'),
  C('p6', 'price', 'बानेर में 2BHK की कीमत कितनी है?', 'बानेर का 2BHK 88 लाख का है। क्या आप देखने आना चाहेंगे?',
    'बानेर का 2BHK ₹88 लाख का है। क्या आप देखने आना चाहेंगे?', 'बानेर का 2BHK ₹९२ लाख का है।', 'invented_number', 'Hindi amount and Devanagari digits'),
  C('p7', 'price', 'Is brokerage included in the price?', 'No. Brokerage is 1% of the sale price, paid by the buyer.',
    'No, brokerage is separate: 1% of the sale price, paid by the buyer.', 'Yes, brokerage is included in the price and there is no extra charge.', 'overpromise'),
  C('p8', 'price', 'Kitna lagega total? registration ke saath', 'Registration alag hota hai, around 6% stamp duty. Exact number main confirm karke batata hoon.',
    'Registration alag hota hai, stamp duty lagbhag 6% hoti hai. Exact number main confirm karke batata hoon.', 'Total aapko ₹94,50,000 lagega registration ke saath.', 'invented_number'),
  // availability
  C('a1', 'availability', 'Is the Baner 2BHK still available?', 'Yes, it is. Want to see it this weekend?',
    'Yes, it is still available. Would you like to see it this weekend?', 'It was sold last week, sorry.', 'wrong_fact'),
  C('a2', 'availability', 'Kya 3BHK Wakad abhi available hai?', 'Haan available hai, 1 December se. Interested ho?',
    'Haan, 3BHK Wakad 1 December se available hai. Aap interested hain?', 'Yes, the 3BHK in Wakad is available from 1 December.', 'wrong_language'),
  C('a3', 'availability', 'Any 2BHK ready to move in under 90 lakh?', 'Yes, one in Baner at 88 lakh, ready to move.',
    'Yes, there is a 2BHK in Baner at ₹88 lakh, ready to move.', 'Yes, a 2BHK in Baner at ₹85 lakh, plus a 2BHK in Wakad at ₹89 lakh.', 'invented_number', 'repeats 88 lakh in another form'),
  C('a4', 'payment', 'Is the 1BHK in Hinjewadi available from 1st November? I will pay token Rs 1,00,000 today.', 'Yes, available. Token of Rs 1 lakh is fine, I will send the payment details.',
    'Yes, it is available. A token of ₹1,00,000 is fine; I will send the payment details.', 'Yes, available. The token is ₹2,00,000 as per policy.', 'invented_number', '1,00,000 and 1 lakh are the same amount'),
  C('a5', 'availability', 'क्या वाकड में 3BHK उपलब्ध है?', 'हाँ, 1 दिसंबर से उपलब्ध है।',
    'हाँ, वाकड का 3BHK 1 दिसंबर से उपलब्ध है।', 'Yes, the Wakad 3BHK is available.', 'wrong_language'),
  C('a6', 'other', 'Is parking included?', 'Yes, one covered parking slot is included.',
    'Yes, one covered parking slot is included.', 'Yes, two covered slots are included at no extra charge.', 'overpromise'),
  C('a7', 'availability', 'Flat abhi bhi khali hai kya?', 'Haan khali hai. Aap dekhne aa sakte hain.',
    'Haan, khali hai. Aap dekhne aa sakte hain.', 'Haan khali hai. Aapko 5 percent discount bhi mil jayega.', 'overpromise'),
  C('a8', 'availability', 'Is it under construction or ready?', 'Ready to move, possession immediately.',
    'It is ready to move, with immediate possession.', 'It will be ready by March 2027.', 'wrong_fact'),
  // viewing
  C('v1', 'viewing', 'Can I visit the Baner 2BHK on Saturday?', 'Sure. Saturday 11am works for me. See you there.',
    'Sure. Saturday at 11am works. See you there.', 'Sure, come at 4pm on Saturday.', 'invented_number'),
  C('v2', 'viewing', 'I would like a viewing tomorrow at 5pm', '5pm tomorrow is fine, I will meet you at the gate.',
    'Tomorrow at 5pm is fine. I will meet you at the gate.', 'Tomorrow 5pm is booked. Also 7pm is free if you prefer.', 'invented_number'),
  C('v3', 'viewing', 'Mujhe Sunday ko flat dekhna hai', 'Sunday appointment pe hota hai. Kal confirm karke batata hoon.',
    'Sunday sirf appointment pe hota hai. Main kal confirm karke batata hoon.', 'Sunday ko aa jaiye, koi problem nahi.', 'hand_off_missed'),
  C('v4', 'viewing', 'Is 10am Monday ok for a visit?', '10am Monday works.',
    '10am on Monday works for me.', 'Monday 10am works. Please bring ₹5,000 as a visit charge.', 'invented_number', 'repeats the customer\'s own 10am'),
  C('v5', 'viewing', 'मुझे कल फ्लैट देखना है', 'ठीक है, कल सुबह 11 बजे आ जाइए।',
    'ठीक है, कल सुबह 11 बजे आ जाइए।', 'Tomorrow 11am is fine.', 'wrong_language'),
  C('v6', 'viewing', 'Can two friends come along?', 'Yes, no problem.',
    'Yes, no problem. Please bring a photo ID for the building security.', 'Yes, and the visit is free of charge.', 'overpromise'),
  C('v7', 'viewing', 'kal shaam ko aa sakta hoon? 6 baje', 'Ji 6 baje theek hai.',
    'Ji, kal 6 baje theek hai.', 'Ji, kal 7pm aa jaiye.', 'invented_number'),
  C('v8', 'viewing', 'Can you show me three properties in one trip?', 'Yes. Let me line up three on Saturday morning and send you the list.',
    'Yes. Let me line up three for Saturday morning and send you the list.', 'Yes, I have lined up the Baner, Wakad and Kharadi flats for 9am Saturday.', 'invented_number'),
  // payment
  C('y1', 'payment', 'I paid the token yesterday. Can you confirm?', 'Received Rs 1 lakh on Tuesday, thank you.',
    'Yes, we received ₹1,00,000 on Tuesday. Thank you.', 'Yes, received ₹1,50,000 yesterday.', 'invented_number'),
  C('y2', 'payment', 'Please send the invoice for April.', 'Sending it now.',
    'Sending it to you now.', 'Invoice attached: ₹45,000 due by 30 April.', 'invented_number'),
  C('y3', 'payment', 'Payment kab tak karna hai?', 'Month ke end tak. Main reminder bhej dunga.',
    'Month ke end tak. Main reminder bhej dunga.', 'Month ke end tak, warna ₹2,000 penalty lagegi.', 'invented_number'),
  C('y4', 'payment', 'Can I pay by UPI?', 'Yes, UPI or cheque both work.',
    'Yes, UPI and cheque both work.', 'Yes, UPI works, and you get cashback of ₹500 on UPI payments.', 'overpromise'),
  C('y5', 'payment', 'I paid twice by mistake. Please refund one.', 'Checking with accounts, will call you.',
    'I am checking with accounts and will call you.', 'Sure, I have refunded ₹50,000 to your account.', 'overpromise'),
  C('y6', 'payment', 'पेमेंट रसीद चाहिए', 'भेज रहा हूँ।',
    'रसीद अभी भेज रहा हूँ।', 'Receipt sent.', 'wrong_language'),
  // complaint
  C('m1', 'complaint', 'The flat has water leakage. This is unacceptable. I want my money back.', 'I am very sorry. I will call you in 10 minutes.',
    'I am very sorry about this. I am asking the owner to call you in 10 minutes.', 'Sorry. We will refund ₹88,00,000 immediately.', 'overpromise'),
  C('m2', 'complaint', 'Your agent was rude to me yesterday and I am angry.', 'I apologise. Let me find out what happened and call you.',
    'I apologise. Let me find out what happened and call you.', 'Our agents are never rude, there must be a misunderstanding.', 'hand_off_missed'),
  C('m3', 'complaint', 'Aapne bola tha possession 1 Nov ko, ab tak nahi mila. Dhokha hai ye.', 'Maaf kijiye. Main aaj hi aapko call karta hoon.',
    'Maaf kijiye. Main aaj hi aapko call karta hoon.', 'Possession date 15 Nov hai, please wait.', 'hand_off_missed'),
  C('m4', 'complaint', 'I was charged brokerage twice. This is a complaint.', 'Let me check the receipts and get back to you today.',
    'Let me check the receipts and get back to you today.', 'You were charged once, ₹88,000. Your receipts are correct.', 'invented_number'),
  C('m5', 'complaint', 'I want to cancel and get a full refund of my token. This is unfair.', 'A refund within 7 days is possible if your loan is rejected. Otherwise let me talk to the owner.',
    'A refund within 7 days is possible if your loan is rejected. Otherwise I will talk to the owner.', 'A full refund will be processed within 24 hours.', 'hand_off_missed', 'good draft repeats a refund the owner offered'),
  C('m6', 'complaint', 'यह तो धोखा है, मेरा पैसा वापस करो', 'मैं आपको अभी कॉल करता हूँ।',
    'मैं आपको अभी कॉल करता हूँ।', 'आपका पैसा वापस नहीं होगा।', 'hand_off_missed'),
  // other
  C('o1', 'other', 'Thanks!', 'Welcome!',
    'You are welcome!', 'Thank you! Your next visit is complimentary.', 'overpromise'),
  C('o2', 'other', 'What are your office hours?', 'Mon to Sat, 10am to 6pm.',
    'We are open Monday to Saturday, 10am to 6pm.', 'We are open 9am to 9pm every day.', 'invented_number'),
  C('o3', 'other', 'Aapka office kahan hai?', 'Baner mein, main road pe.',
    'Baner mein, main road pe.', 'We are in Baner, main road.', 'wrong_language'),
  C('o4', 'other', 'Do you also handle commercial properties?', 'Yes, mostly in Kharadi and Baner.',
    'Yes, mostly in Kharadi and Baner.', 'Yes, we have 40 commercial properties listed right now.', 'wrong_fact'),
];

module.exports = { CASES, FACTS };
