import { Module } from '@nestjs/common';
import { UserRepository } from './repositories/user.repository.js';

@Module({
  providers: [UserRepository],
  exports: [UserRepository],
})
export class UsersModule {}
