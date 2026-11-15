import {ApiError} from '../../shared/errors';
import {privacyRequest} from '../../shared/privacy';
import type {PrivacyRepository} from '../contracts/privacy-repository';
import {createD1PrivacyReader} from './privacy-reader';
import {createD1PrivacyEraser} from './privacy-eraser';
export function createD1PrivacyRepository(database:D1Database):PrivacyRepository{return {async execute(installation,input){
 const parsed=privacyRequest.safeParse(input);if(!parsed.success)throw new ApiError(400,'VALIDATION_ERROR','Invalid privacy request.');
 return parsed.data.action==='erase'?createD1PrivacyEraser(database).execute(installation,parsed.data):createD1PrivacyReader(database).execute(installation,parsed.data);
}};}
