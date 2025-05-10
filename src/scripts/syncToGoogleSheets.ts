import { LumaService } from '../services/luma';
import { GoogleSheetsService } from '../services/googleSheets';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  // 初始化服务
  const lumaService = new LumaService(process.env.LUMA_API_KEY!);
  const sheetsService = new GoogleSheetsService(
    process.env.GOOGLE_CLIENT_EMAIL!,
    process.env.GOOGLE_PRIVATE_KEY!,
    process.env.GOOGLE_SHEET_ID!
  );
  
  try {
    // 获取所有事件
    console.log('正在获取所有事件...');
    const events = await lumaService.getAllEvents();
    console.log(`获取到 ${events.length} 个事件`);
    
    // 同步事件到 Google Sheets
    console.log('正在同步事件到 Google Sheets...');
    await sheetsService.syncEvents(events.map(e => e.event));
    
    // 获取并同步每个事件的参与者
    for (const event of events) {
      console.log(`正在获取事件 ${event.event.name} 的参与者...`);
      const guests = await lumaService.getEventGuests(event.event.api_id);
      console.log(`获取到 ${guests.length} 个参与者`);
      
      console.log(`正在同步参与者到 Google Sheets...`);
      await sheetsService.syncGuests(event.event.api_id, guests);
    }
    
    console.log('同步完成！');
  } catch (error) {
    console.error('同步过程中发生错误:', error);
  }
}

main(); 