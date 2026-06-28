import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { connectDB, disconnectDB, addUser, removeUser, getUser, validateUser } from '../main/database/database.js';
import argon2 from '@node-rs/argon2';

dotenv.config();

// These are integration tests that require a live MongoDB instance.
// Skip the whole suite when MONGO_URI is not configured instead of failing.
const describeWithMongo = process.env.MONGO_URI ? describe : describe.skip;

describeWithMongo('Database Functions - Integration Tests', () => {
  let client
  let database
  let collection

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGO_URI)
    await client.connect()
    database = client.db('modmngr')
    collection = database.collection('logins')
  })

  afterAll(async () => {
    await client.close()
    await disconnectDB() // Close the connection from database.js module
  })

  afterEach(async () => {
    // Clean up test data after each test
    await collection.deleteMany({ 
      $or: [
        { username: { $regex: /^testuser/ } },
        { email: { $regex: /^test.*@test\.com$/ } }
      ]
    })
  })

  describe('addUser', () => {
    it('should add user to database with hashed password', async () => {
      await addUser('testuser', 'test@test.com', 'testpassword')
      
      // Verify the user was added
      const user = await collection.findOne({ username: 'testuser' })
      expect(user).toBeTruthy()
      expect(user.username).toBe('testuser')
      expect(user.email).toBe('test@test.com')
      expect(user.password).toBeTruthy()
      expect(user.password).not.toBe('testpassword') // Should be hashed

      // Verify password was properly hashed with argon2
      const isValid = await argon2.verify(user.password, 'testpassword')
      expect(isValid).toBe(true)
    })

    it('should hash different passwords differently', async () => {
      await addUser('testuser1', 'test1@test.com', 'password1')
      await addUser('testuser2', 'test2@test.com', 'password2')
      
      const user1 = await collection.findOne({ username: 'testuser1' })
      const user2 = await collection.findOne({ username: 'testuser2' })
      
      expect(user1.password).not.toBe(user2.password)
    })

    it('should throw error when username is null or empty', async () => {
      await expect(addUser(null, 'test@test.com', 'password'))
        .rejects.toThrow('Username, email, and password are required')
      
      await expect(addUser('', 'test@test.com', 'password'))
        .rejects.toThrow('Username, email, and password are required')
    })

    it('should throw error when email is null or empty', async () => {
      await expect(addUser('testuser', null, 'password'))
        .rejects.toThrow('Username, email, and password are required')
      
      await expect(addUser('testuser', '', 'password'))
        .rejects.toThrow('Username, email, and password are required')
    })

    it('should throw error when password is null or empty', async () => {
      await expect(addUser('testuser', 'test@test.com', null))
        .rejects.toThrow('Username, email, and password are required')
      
      await expect(addUser('testuser', 'test@test.com', ''))
        .rejects.toThrow('Username, email, and password are required')
    })

    it('should throw error when all parameters are missing', async () => {
      await expect(addUser(null, null, null))
        .rejects.toThrow('Username, email, and password are required')
    })
  })

  describe('getUser', () => {
    beforeEach(async () => {
      // Add test users before each test
      await addUser('testuser', 'test@test.com', 'testpassword')
    })

    it('should get user by username', async () => {
      const user = await getUser('testuser')
      
      expect(user).toBeTruthy()
      expect(user.username).toBe('testuser')
      expect(user.email).toBe('test@test.com')
      // Password hash must never be exposed by getUser
      expect(user.password).toBeUndefined()
    })

    it('should get user by email', async () => {
      const user = await getUser(null, 'test@test.com')
      
      expect(user).toBeTruthy()
      expect(user.username).toBe('testuser')
      expect(user.email).toBe('test@test.com')
      expect(user.password).toBeUndefined()
    })

    it('should return null if user not found by username', async () => {
      const user = await getUser('nonexistentuser')
      
      expect(user).toBeNull()
    })

    it('should return null if user not found by email', async () => {
      const user = await getUser(null, 'nonexistent@test.com')
      
      expect(user).toBeNull()
    })

    it('should prioritize username over email when both provided', async () => {
      const user = await getUser('testuser', 'wrong@test.com')
      
      expect(user).toBeTruthy()
      expect(user.email).toBe('test@test.com')
    })
  })

  describe('validateUser', () => {
    beforeEach(async () => {
      // Add test user before each test
      await addUser('testuser', 'test@test.com', 'correctpassword')
    })

    it('should return true for correct username and password', async () => {
      const isValid = await validateUser('testuser', 'correctpassword')
      
      expect(isValid).toBe(true)
    })

    it('should return false for correct username but wrong password', async () => {
      const isValid = await validateUser('testuser', 'wrongpassword')
      
      expect(isValid).toBe(false)
    })

    it('should return false for non-existent username', async () => {
      const isValid = await validateUser('nonexistentuser', 'anypassword')
      
      expect(isValid).toBe(false)
    })

    it('should return false for empty password', async () => {
      const isValid = await validateUser('testuser', '')
      
      expect(isValid).toBe(false)
    })

    it('should return false when username is null or undefined', async () => {
      const isValidNull = await validateUser(null, 'password')
      expect(isValidNull).toBe(false)
      
      const isValidUndefined = await validateUser(undefined, 'password')
      expect(isValidUndefined).toBe(false)
    })

    it('should return false when password is null or undefined', async () => {
      const isValidNull = await validateUser('testuser', null)
      expect(isValidNull).toBe(false)
      
      const isValidUndefined = await validateUser('testuser', undefined)
      expect(isValidUndefined).toBe(false)
    })

    it('should return false when both username and password are null', async () => {
      const isValid = await validateUser(null, null)
      expect(isValid).toBe(false)
    })
  })

  describe('removeUser', () => {
    beforeEach(async () => {
      // Add test user before each test
      await addUser('testuser', 'test@test.com', 'testpassword')
    })

    it('should remove user with correct email and password', async () => {
      const result = await removeUser('test@test.com', 'testpassword')
      
      expect(result).toBe(true)
      
      // Verify user was actually removed
      const user = await collection.findOne({ email: 'test@test.com' })
      expect(user).toBeNull()
    })

    it('should not remove user with wrong password', async () => {
      const result = await removeUser('test@test.com', 'wrongpassword')
      
      expect(result).toBe(false)
      
      // Verify user still exists
      const user = await collection.findOne({ email: 'test@test.com' })
      expect(user).toBeTruthy()
    })

    it('should return false for non-existent email', async () => {
      const result = await removeUser('nonexistent@test.com', 'anypassword')
      
      expect(result).toBe(false)
    })

    it('should not remove user with empty password', async () => {
      const result = await removeUser('test@test.com', '')
      
      expect(result).toBe(false)
      
      // Verify user still exists
      const user = await collection.findOne({ email: 'test@test.com' })
      expect(user).toBeTruthy()
    })

    it('should return false when email is null or undefined', async () => {
      const resultNull = await removeUser(null, 'password')
      expect(resultNull).toBe(false)
      
      const resultUndefined = await removeUser(undefined, 'password')
      expect(resultUndefined).toBe(false)
    })

    it('should return false when password is null or undefined', async () => {
      const resultNull = await removeUser('test@test.com', null)
      expect(resultNull).toBe(false)
      
      const resultUndefined = await removeUser('test@test.com', undefined)
      expect(resultUndefined).toBe(false)
      
      // Verify user still exists
      const user = await collection.findOne({ email: 'test@test.com' })
      expect(user).toBeTruthy()
    })

    it('should return false when both email and password are null', async () => {
      const result = await removeUser(null, null)
      expect(result).toBe(false)
    })
  })

  describe('connectDB and disconnectDB', () => {
    it('should connect to database', async () => {
      // Note: connectDB is likely already called by other tests
      // This test verifies it can be called without errors
      await expect(connectDB()).resolves.toBeTruthy()
    })

    it('should disconnect from database and reconnect', async () => {
      await disconnectDB()
      await expect(connectDB()).resolves.toBeTruthy()
    })
  })

})