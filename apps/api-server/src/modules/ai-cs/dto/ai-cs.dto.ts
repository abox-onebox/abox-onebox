import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AiCsAskDto {
  @ApiProperty({ description: '用户提问（消费者侧自然语言）', example: '你们有食品经营许可证吗' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  question!: string;
}
