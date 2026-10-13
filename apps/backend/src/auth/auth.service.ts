import { Injectable, NotImplementedException } from '@nestjs/common';

import { ActivateAccountDto } from './dto/activate-account.dto.js';

@Injectable()
export class AuthService {
  activate(_activateAccountDto: ActivateAccountDto): never {
    throw new NotImplementedException();
  }
}
