// Замените существующий endpoint /slots на этот с обработкой ошибок:
app.post('/slots', (req, res) => {
  try {
    console.log('🔍 /slots request received:', {
      body: req.body,
      timestamp: new Date().toISOString()
    });
    
    const { direction, address, days = 3 } = req.body;
    
    // Проверяем обязательные параметры
    if (!direction || !address) {
      console.log('❌ Missing required parameters');
      return res.status(400).json({ 
        ok: false, 
        error: 'Missing required parameters: direction and address' 
      });
    }
    
    console.log('📊 Request parameters:', {
      direction: direction,
      address: address,
      days: days
    });
    
    // Проверяем, есть ли расписания вообще
    console.log('📅 Available schedules:', {
      totalAddresses: Object.keys(schedules).length,
      addresses: Object.keys(schedules)
    });
    
    // Проверяем конкретный адрес
    const arr = schedules[address] || [];
    console.log(`📍 Schedule for address "${address}":`, {
      found: !!schedules[address],
      slotsCount: arr.length
    });
    
    if (arr.length === 0) {
      console.log('⚠️ No slots found for this address');
      return res.json({ ok: true, slots: [] });
    }
    
    const now = new Date();
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + days);
    
    console.log('⏰ Time range:', {
      now: now.toISOString(),
      targetDate: targetDate.toISOString(),
      daysAhead: days
    });

    const slots = arr
      .filter(slot => {
        try {
          // Проверяем, что у слота есть все необходимые поля
          if (!slot.date || !slot.time || !slot.direction) {
            console.log('⚠️ Invalid slot structure:', slot);
            return false;
          }
          
          const slotDateTime = new Date(`${slot.date}T${slot.time}`);
          const directionMatch = slot.direction.trim().toLowerCase() === direction.trim().toLowerCase();
          const timeValid = !isNaN(slotDateTime.getTime());
          const timeInRange = slotDateTime >= now && slotDateTime <= targetDate;
          
          return directionMatch && timeValid && timeInRange;
        } catch (slotError) {
          console.error('❌ Error processing slot:', slot, slotError);
          return false;
        }
      })
      .map(slot => ({ date: slot.date, time: slot.time }))
      .sort((a, b) => {
        const dateA = new Date(`${a.date}T${a.time}`);
        const dateB = new Date(`${b.date}T${b.time}`);
        return dateA - dateB;
      });

    console.log('✅ Final result:', {
      slotsFound: slots.length,
      slots: slots.slice(0, 5) // Показываем только первые 5 для логов
    });

    res.json({ ok: true, slots });
    
  } catch (error) {
    console.error('❌ Error in /slots endpoint:', error);
    console.error('Stack trace:', error.stack);
    
    res.status(500).json({ 
      ok: false, 
      error: 'Internal server error',
      message: error.message 
    });
  }
});
