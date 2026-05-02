import express from 'express';
import Groq from 'groq-sdk';
import Debt from '../models/Debt.js';
import SavingsGoal from '../models/SavingsGoal.js';

const router = express.Router();

// GET all debts for a user
router.get('/', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'uid is required' });
    const debts = await Debt.find({ userId: uid }).sort({ interestRate: -1 });
    res.json(debts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch debts' });
  }
});

// POST a new debt
router.post('/', async (req, res) => {
  try {
    const { uid, name, category, principalAmount, remainingAmount, interestRate, interestType, emiAmount, reason, startDate, dueDate } = req.body;
    if (!uid || !name || principalAmount == null || remainingAmount == null || interestRate == null) {
      return res.status(400).json({ error: 'uid, name, principalAmount, remainingAmount, and interestRate are required' });
    }
    const debt = new Debt({
      userId: uid, name, category, principalAmount, remainingAmount,
      interestRate, interestType, emiAmount, reason, startDate, dueDate,
    });
    await debt.save();
    res.status(201).json(debt);
  } catch (err) {
    console.error('Add debt error:', err);
    res.status(500).json({ error: 'Failed to add debt' });
  }
});

// PUT update a debt
router.put('/:id', async (req, res) => {
  try {
    const updated = await Debt.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ error: 'Debt not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update debt' });
  }
});

// DELETE a debt
router.delete('/:id', async (req, res) => {
  try {
    await Debt.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete debt' });
  }
});

// POST AI Debt Advice — analyzes all debts and recommends payoff strategy
router.post('/ai-advice', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid is required' });

    if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_api_key_here' || process.env.GROQ_API_KEY === '') {
      console.warn('GROQ_API_KEY is not configured.');
      return res.status(200).json({ response: "AI advice is currently unavailable. Please configure your GROQ_API_KEY in the backend environment variables." });
    }

    const debts = await Debt.find({ userId: uid });
    if (debts.length === 0) {
      return res.json({ response: "🎉 **Congratulations!** You have no debts recorded. Keep up the great financial discipline!" });
    }

    // Try to fetch profile but don't fail if not found
    let monthlySalary = 0;
    let monthlySavings = 0;
    try {
      const savingsProfile = await SavingsGoal.findOne({ userId: uid });
      monthlySalary = savingsProfile?.monthlySalary || 0;
      monthlySavings = savingsProfile?.monthlySavings || 0;
    } catch (profileErr) {
      console.warn('Optional profile fetch failed:', profileErr);
    }

    const totalDebt = debts.reduce((s, d) => s + d.remainingAmount, 0);
    const totalEMI = debts.reduce((s, d) => s + d.emiAmount, 0);

    const debtDetails = debts.map(d => {
      const monthlyRate = d.interestRate / 12 / 100;
      let monthlyInterestCost = 0;
      if (d.interestType === 'compound_monthly' || d.interestType === 'reducing_balance') {
        monthlyInterestCost = d.remainingAmount * monthlyRate;
      } else if (d.interestType === 'compound_daily') {
        // Credit cards typically charge compound daily
        const dailyRate = d.interestRate / 365 / 100;
        monthlyInterestCost = d.remainingAmount * (Math.pow(1 + dailyRate, 30) - 1);
      } else {
        monthlyInterestCost = (d.remainingAmount * d.interestRate / 100) / 12;
      }
      
      return `  - **${d.name}** (${d.category.replace(/_/g, ' ')}):
    Outstanding: ₹${d.remainingAmount.toLocaleString('en-IN')}
    Interest Rate: ${d.interestRate}% p.a. (${d.interestType.replace(/_/g, ' ')})
    Monthly Interest Cost: ~₹${Math.round(monthlyInterestCost).toLocaleString('en-IN')}
    EMI/Payment: ₹${d.emiAmount.toLocaleString('en-IN')}
    Reason: ${d.reason || 'Not specified'}
    ${d.interestType === 'compound_daily' ? '⚠️ This debt compounds DAILY — interest grows much faster!' : ''}`;
    }).join('\n');

    const prompt = `You are an expert Indian financial advisor specializing in debt management. Analyze the user's debts and provide a comprehensive payoff strategy.

### User's Financial Profile:
- **Monthly Salary:** ₹${monthlySalary.toLocaleString('en-IN')}
- **Monthly Savings Target:** ₹${monthlySavings.toLocaleString('en-IN')}
- **Total Outstanding Debt:** ₹${totalDebt.toLocaleString('en-IN')}
- **Total Monthly EMI/Payments:** ₹${totalEMI.toLocaleString('en-IN')}
- **Debt-to-Income Ratio:** ${monthlySalary > 0 ? ((totalEMI / monthlySalary) * 100).toFixed(1) : 'N/A'}%

### Debt Details:
${debtDetails}

### Required Analysis:
1. **Priority Order**: Which debt should be paid off FIRST and why? Consider the REAL cost of each debt — credit cards with daily compounding cost FAR more than their stated rate suggests. Compare effective annual rates.

2. **Strategy Recommendation**: Between Avalanche (highest interest first) vs Snowball (smallest balance first), recommend the BEST approach for this specific profile with reasoning.

3. **Monthly Action Plan**: Given their salary of ₹${monthlySalary.toLocaleString('en-IN')}, suggest how much extra they can pay toward the priority debt each month.

4. **Interest Savings**: Calculate approximate interest savings if they follow your plan vs paying only minimum EMIs.

5. **Timeline**: Estimate when they can be completely debt-free following your strategy.

6. **Warning Signs**: Flag any debts that are particularly dangerous (like high-rate credit cards, compound daily interest) and explain WHY in simple terms.

7. **Quick Wins**: Any debts that are close to being paid off that could free up cash flow?

Format your response in clear Markdown with headers, bullet points, and bold text. Use ₹ symbol for amounts. Keep language simple and actionable. End with a disclaimer.`;

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'You are a professional Indian financial advisor specializing in debt management. Be specific, actionable, and use real numbers from the data.' },
        { role: 'user', content: prompt },
      ],
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2000,
    });

    const aiResponse = completion.choices[0]?.message?.content || "Sorry, couldn't generate advice. Please try again.";
    res.json({ response: aiResponse });

  } catch (error) {
    console.error('Debt AI Advice Error:', error);
    res.status(500).json({ error: 'Failed to generate debt advice.' });
  }
});

export default router;
