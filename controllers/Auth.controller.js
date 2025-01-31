const User = require("../models/User.model.js");
const OTP = require("../models/Otp.model.js");
const Profile = require("../models/Profile.model.js");
const otpGenerator = require("otp-generator");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mailSender = require("../utils/mailSender.utils.js");
const JoiErrorHandler = require("../utils/errorHandler.utils.js");
const { USER_GENDER } = require("../config/constants.js");
const {
  sendOTPSchema,
  signupSchema,
  loginSchema,
  changePasswordSchema,
} = require("../validations/Auth.validations.js");
const {
  updatePasswordEmail,
} = require("../emails/templates/passwordUpdated.email.js");
const { generateTokens } = require("../utils/jwtHandler.js");
require("dotenv").config();

// send otp
exports.sendOTP = async (req, res) => {
  try {
    // validate coming data request body using joi
    const { error, value } = sendOTPSchema.validate(req.body);

    if (error) {
      return res.status(400).json(JoiErrorHandler(error));
    }
    const { email } = value;

    const isUserPresent = await User.findOne({ email });
    if (isUserPresent) {
      return res.status(409).json({
        success: false,
        message: "User already exists!",
      });
    }

    // generate otp
    var otp = Number(
      otpGenerator.generate(6, {
        upperCaseAlphabets: false,
        lowerCaseAlphabets: false,
        specialChars: false,
      })
    );

    // check is otp is unique or not
    const result = await OTP.findOne({ otp });
    while (result) {
      otp = otpGenerator.generate(6, {
        upperCaseAlphabets: false,
        lowerCaseAlphabets: false,
        specialChars: false,
      });
      result = await OTP.findOne({ otp });
    }

    // create an entry in db
    const otpPayload = { email, otp };

    const otpBody = await OTP.create(otpPayload);

    // return response
    res.status(200).json({
      success: true,
      message: "OTP Sent Successfully",
      otp: otp,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Something went wrong while sending OTP",
      error: error.message,
    });
  }
};

// signup
exports.signup = async (req, res) => {
  try {
    // validate coming data request body using joi
    const { error, value } = signupSchema.validate(req.body);
    if (error) {
      return res.status(400).json(JoiErrorHandler(error));
    }

    // destructure data
    const { firstName, lastName, email, phoneNo, accountType, password, otp } =
      value;

    // check user already exists of not
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "User already exists!",
      });
    }

    // find most recent otp for the user
    const recentOTP = await OTP.find({ email })
      .sort({ createdAt: -1 })
      .limit(1);

    // validate OTP
    if (recentOTP.length == 0) {
      // OTP not found
      return res.status(400).json({
        succes: false,
        message: "OTP Not Found",
      });
    } else if (otp !== recentOTP[0].otp) {
      // Invalid OTP
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    // hash the password
    const hasedPassword = await bcrypt.hash(password, 8);

    // create profile of the user
    const profileDetails = await Profile.create({
      gender: USER_GENDER.NULL,
      dob: null,
      about: null,
      phoneNo: phoneNo,
    });

    // create entry in DB
    const user = await User.create({
      firstName,
      lastName,
      email,
      password: hasedPassword,
      accountType,
      additionalDetails: profileDetails._id,
      avatar: `https://api.dicebear.com/8.x/initials/svg?seed=${firstName}%20${lastName}`,
    });

    // return response
    return res.status(200).json({
      success: true,
      message: "User is registered successfully",
      data: user,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error while user registration",
      error: error.message,
    });
  }
};

// login
exports.login = async (req, res) => {
  try {
    // validating the data using Joi
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json(JoiErrorHandler(error));
    }

    // fetch the data from value
    const { email, password } = value;

    // check does user exist or not
    let user = await User.findOne({ email }).populate("additionalDetails");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // generate JWT, after password matches
    if (await bcrypt.compare(password, user.password)) {
      const { accessToken, refreshToken } = generateTokens(user);
      user = user.toObject();
      user.accessToken = accessToken;
      user.refreshToken = refreshToken;

      user.password = undefined;
      delete user.password;

      if (user.isDeleted) {
        return res.status(200).json({
          success: true,
          message: "User has been requested for account deletion.",
          data: user,
        });
      }

      // create cookie and send response
      const options = {
        expires: new Date(Date.now() + 3 * 24 * 60 * 60 * 100),
      };
      res.cookie("accessToken", accessToken, options).status(200).json({
        success: true,
        message: "Logged in successfully",
        data: user,
      });
    } else {
      return res.status(403).json({
        success: false,
        message: "Password is incorrect",
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error while login",
      error: error.message,
    });
  }
};

// change password
exports.changePassword = async (req, res) => {
  try {
    // validate input data using Joi
    const { error, value } = changePasswordSchema.validate(req.body);
    if (error) {
      return res.status(400).json(JoiErrorHandler(error));
    }

    // get old password, new password, confirm password from value
    const { oldPassword, newPassword } = value;

    // check is user authenticated or not
    if (!req.user.id) {
      return res.status(403).json({
        succes: false,
        message: "User need to authenticated first to change password.",
      });
    }

    // get the user details from datbase
    const user = await User.findOne({ _id: req.user.id, isDeleted: false });

    // compare oldPassword with database
    if (!(await bcrypt.compare(oldPassword, user.password))) {
      return res.status(403).json({
        success: false,
        message: "Old password is incorrect",
      });
    }

    // update the password in database
    user.password = await bcrypt.hash(newPassword, 8);

    // save in database
    await user.save();

    // send mail of password update
    const title = "Your password is changed successfully";
    const name = user.firstName + " " + user.lastName;
    const body = updatePasswordEmail(user.email, name);
    await mailSender(user.email, title, body);

    // return res
    res.status(200).json({
      success: true,
      message: "Your password changed successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error while changing your password",
      error: error.message,
    });
  }
};

// refresh the expired access token
exports.tokenRefresh = async (req, res) => {
  try {
    const refreshToken = req.body.token;
    if (!refreshToken) {
      return res.status(404).json({
        success: false,
        message: "Token not found",
      });
    }

    const payloadData = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_TOKEN_SECRET
    );
    const userId = payloadData.id;
    const user = await User.findById({ _id: userId });

    // validate the user
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // validate the user is not deleted
    if (user.isDeleted) {
      return res.status(403).json({
        success: false,
        message: "User has been requested for account deletion.",
      });
    }

    // now generate a new access token and send it to user
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);

    // send these to user
    return res.status(200).json({
      succes: true,
      message: "Token refreshed successfully",
      data: {
        accessToken: accessToken,
        refreshToken: newRefreshToken,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to generate a new token!",
      error: error.message,
    });
  }
};

// get user data
exports.getUser = async (req, res) => {
  try {
    const userId = req.user.id;
    const userData = await User.findById({ _id: userId })
      .populate({ path: "additionalDetails", select: "-_id" })
      .select("-password -_id");

    // validate the user
    if (!userData) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    return res.status(200).json({
      success: false,
      message: "Authentication Successfull!",
      data: userData,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Authentication Failed!",
      error: error.message,
    });
  }
};
